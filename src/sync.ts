import type { Env } from "./env";
import { type Config, credsFor, isConfigured, loadConfig } from "./config";
import { fernetDecrypt, FernetError } from "./fernet";
import { PlaidError, plaidMessageOf, plaidPost, plaidPostText, statusForCode, statusForError } from "./plaid";

/** Port of app/sync_engine.py for Workers limits (free plan: 10 ms CPU, 50 subrequests).
 *  - Each /transactions/sync page is persisted in ONE D1 batch (a single transaction): accounts,
 *    added/modified transactions, removals and the cursor advance. The cursor therefore only
 *    moves after its page is saved, and a crash mid-page changes nothing.
 *  - The Worker never parses a page. Plaid's response text is sent to D1 once, into sync_pages;
 *    SQLite unpacks it (json_each) and hands back just next_cursor / has_more.
 *  - CPU, measured on Cloudflare (2026-09-25): ~4 ms fixed per run plus ~1.5-2 ms per 100
 *    full-detail transactions (~150 KiB of page text). The free plan allows 10 ms per run, so
 *    each run has a byte budget (SYNC_MAX_BYTES_PER_RUN, default 150 KB = ~1 page, measured
 *    ~8 ms) as well as a page budget (SYNC_MAX_PAGES_PER_RUN, bounds subrequests). Hourly runs
 *    are tiny once caught up; a new bank's full history fills in over many runs. On Workers Paid
 *    (30 s CPU) raise both, e.g. 20000000 bytes / 50 pages.
 *  - A per-run page budget bounds Plaid calls and D1 queries; when it runs out the next run
 *    resumes from the stored cursor. Transaction tags (transaction_tags) are never touched.
 *  - So one update (e.g. a bank's first two years of history) can span many runs, and Plaid's data
 *    may change in between: TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION. Plaid says to restart
 *    the whole update from the cursor it began with, so items.sync_start_cursor keeps that cursor
 *    until the update is caught up. Restarting from this run's cursor instead fails every time.
 *  - Two cron triggers: the hourly sweep of every bank, and a 10-minute catch-up that only
 *    continues unfinished updates, so a long history finishes in hours, leaving Plaid little
 *    time to change it mid-download. */

export const PAGE_SIZE = 100;            // ~150 KiB of full-detail transactions; small steps for the byte budget
export const DEFAULT_PAGES_PER_RUN = 10;
export const DEFAULT_BYTES_PER_RUN = 150_000;

/** The catch-up trigger (wrangler.jsonc "triggers"): only banks partway through an update. Any
 * other cron, i.e. the hourly "17 * * * *", sweeps every bank. */
export const CATCH_UP_CRON = "*/10 * * * *";

export type ItemResult = "good" | "partial" | "login_required" | "error" | "retry" | "skipped";

/** What one run may still spend. bytes: page text (~7 us CPU per KiB); omitted = unlimited. */
export interface Budget { pages: number; bytes?: number }

const canSpend = (b: Budget) => b.pages > 0 && (b.bytes === undefined || b.bytes > 0);

export interface ItemRow {
  id: number;
  owner: string;
  plaid_account: string;
  access_token_enc: string;
  txn_cursor: string | null;
  sync_start_cursor: string | null;
  status: string;
}

const MUTATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// The current page's JSON text, from the scratch row for item ?1.
const PAGE = "(SELECT body FROM sync_pages WHERE item_id = ?1)";

// Stored only if it's JSON with a text next_cursor. Otherwise nothing is stored, every statement
// below becomes a no-op (the cursor stays put), and PAGE_INFO returns no row -> retry next run.
const STAGE_PAGE = `
  INSERT OR REPLACE INTO sync_pages (item_id, body)
  SELECT ?1, ?2 WHERE json_valid(?2) AND json_type(?2, '$.next_cursor') = 'text'`;

const UPSERT_ACCOUNTS = `
  INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype,
                        balance_current_cents, balance_available_cents, credit_limit_cents, currency, updated_at)
  SELECT ?2, ?1, a.value ->> 'account_id', a.value ->> 'name', a.value ->> 'mask',
         a.value ->> 'type', a.value ->> 'subtype',
         CAST(round((a.value -> 'balances' ->> 'current') * 100) AS INTEGER),
         CAST(round((a.value -> 'balances' ->> 'available') * 100) AS INTEGER),
         CAST(round((a.value -> 'balances' ->> 'limit') * 100) AS INTEGER),
         a.value -> 'balances' ->> 'iso_currency_code', ${NOW}
  FROM json_each(${PAGE}, '$.accounts') a
  WHERE true
  ON CONFLICT (plaid_account_id) DO UPDATE SET
    name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
    balance_current_cents = excluded.balance_current_cents,
    balance_available_cents = excluded.balance_available_cents,
    credit_limit_cents = excluded.credit_limit_cents,
    currency = excluded.currency, updated_at = excluded.updated_at`;

// Transactions whose account isn't known yet are skipped (the JOIN drops them);
// a later page's accounts[] backfills them. 'tags' live elsewhere and are never written here.
// account_owner is Plaid's card member on multi-card accounts (e.g. Amex authorized users).
const UPSERT_TRANSACTIONS = `
  INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, currency, date, datetime,
                            name, merchant_name, category, category_detailed, category_confidence,
                            pending, pending_txn_id, account_owner)
  SELECT ?2, acc.id, t.value ->> 'transaction_id',
         CAST(round((t.value ->> 'amount') * 100) AS INTEGER),
         t.value ->> 'iso_currency_code', t.value ->> 'date', t.value ->> 'datetime',
         t.value ->> 'name', t.value ->> 'merchant_name',
         t.value -> 'personal_finance_category' ->> 'primary',
         t.value -> 'personal_finance_category' ->> 'detailed',
         t.value -> 'personal_finance_category' ->> 'confidence_level',
         CASE WHEN t.value ->> 'pending' THEN 1 ELSE 0 END,
         t.value ->> 'pending_transaction_id',
         t.value ->> 'account_owner'
  FROM (SELECT value FROM json_each(${PAGE}, '$.added') UNION ALL SELECT value FROM json_each(${PAGE}, '$.modified')) t
  -- Keep each transaction as the outer loop: the account id lookup is unique. Letting SQLite
  -- start with an Item's accounts instead repeats the JSON page scan once per account.
  CROSS JOIN accounts acc ON acc.plaid_account_id = t.value ->> 'account_id' AND acc.item_id = ?1
  WHERE true
  ON CONFLICT (plaid_txn_id) DO UPDATE SET
    account_id = excluded.account_id, currency = excluded.currency,
    amount_cents = excluded.amount_cents, date = excluded.date, datetime = excluded.datetime,
    name = excluded.name, merchant_name = excluded.merchant_name, category = excluded.category,
    category_detailed = excluded.category_detailed, category_confidence = excluded.category_confidence,
    pending = excluded.pending, pending_txn_id = excluded.pending_txn_id,
    account_owner = excluded.account_owner`;

const DELETE_REMOVED = `
  DELETE FROM transactions
  WHERE account_id IN (SELECT id FROM accounts WHERE item_id = ?1)
    AND plaid_txn_id IN (SELECT value ->> 'transaction_id' FROM json_each(${PAGE}, '$.removed'))`;

// Some responses omit the update status; an omission must not erase previously observed
// completeness. Preserve the source status, but only known historical-complete updates can
// establish a covered period. A caught-up cursor alone does not mean history has arrived.
const UPDATE_STATUS = `coalesce(CASE WHEN ${PAGE} ->> '$.transactions_update_status'
  IN ('NOT_READY', 'INITIAL_UPDATE_COMPLETE', 'HISTORICAL_UPDATE_COMPLETE')
  THEN ${PAGE} ->> '$.transactions_update_status' END, transactions_update_status)`;

// ?2 = the cursor this page was requested with ('' = none). While has_more, sync_start_cursor
// keeps the cursor the update began from; it's cleared once the update is caught up.
const ADVANCE_CURSOR = `
  UPDATE items SET txn_cursor = ${PAGE} ->> '$.next_cursor', status = 'good', updated_at = ${NOW},
    attempted_at = ${NOW}, last_error = NULL, last_error_message = NULL, last_error_at = NULL,
    transactions_update_status = ${UPDATE_STATUS},
    transactions_history_start_date = CASE
      WHEN NOT (${PAGE} ->> '$.has_more') AND ${UPDATE_STATUS} = 'HISTORICAL_UPDATE_COMPLETE'
      THEN coalesce(transactions_history_start_date, transactions_history_requested_start_date, date('now'))
      ELSE transactions_history_start_date END,
    sync_start_cursor = CASE WHEN ${PAGE} ->> '$.has_more' THEN coalesce(sync_start_cursor, ?2) END
  WHERE id = ?1 AND EXISTS (SELECT 1 FROM sync_pages WHERE item_id = ?1)`;

// Restart an update from where it began (?2; '' = the very beginning), saved so that a run whose
// budget ends right here resumes from the restart point, not the rejected cursor.
const RESTART_UPDATE = `
  UPDATE items SET txn_cursor = NULLIF(?2, ''), sync_start_cursor = ?2,
    attempted_at = ${NOW}, last_error = ?3, last_error_message = ?4, last_error_at = ${NOW}
  WHERE id = ?1`;

// A failed attempt: ?2 = new status (NULL keeps it), ?3 = an error code and ?4 Plaid's text for
// it (never data).
const RECORD_FAILURE = `
  UPDATE items SET status = coalesce(?2, status), attempted_at = ${NOW},
    last_error = ?3, last_error_message = ?4, last_error_at = ${NOW}
  WHERE id = ?1`;

const PAGE_INFO = `SELECT ${PAGE} ->> '$.next_cursor' AS next_cursor, ${PAGE} ->> '$.has_more' AS has_more
                   WHERE EXISTS (SELECT 1 FROM sync_pages WHERE item_id = ?1)`;

const UNSTAGE_PAGE = "DELETE FROM sync_pages WHERE item_id = ?1";

const positiveInt = (raw: string | undefined, def: number) => {
  const n = Number(raw ?? def);
  return Number.isInteger(n) && n > 0 ? n : def;
};

export const pagesPerRun = (env: Env) => positiveInt(env.SYNC_MAX_PAGES_PER_RUN, DEFAULT_PAGES_PER_RUN);
export const bytesPerRun = (env: Env) => positiveInt(env.SYNC_MAX_BYTES_PER_RUN, DEFAULT_BYTES_PER_RUN);

/** Sync one Item from its stored cursor until caught up or the budget is spent. */
export async function syncItem(env: Env, config: Config, item: ItemRow, budget: Budget): Promise<ItemResult> {
  if (!config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account)) {
    // e.g. the person was removed from MINTY_USERS, or their keys aren't set: don't touch the item
    console.warn(`sync: skipping item ${item.id}: plaid_account ${item.plaid_account} is not configured`);
    return "skipped";
  }
  if (!env.TOKEN_ENC_KEY) {
    console.error("sync: TOKEN_ENC_KEY is not set");
    return "retry";
  }
  const creds = credsFor(env, config, item.plaid_account);   // routes to the item's own Trial account

  let accessToken: string;
  try {
    accessToken = await fernetDecrypt(item.access_token_enc, env.TOKEN_ENC_KEY);
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    console.error(`sync: item ${item.id}: access token doesn't decrypt with TOKEN_ENC_KEY`);
    await recordFailure(env, item.id, "error", "TOKEN_DOES_NOT_DECRYPT");
    return "error";
  }

  let cursor = item.txn_cursor ?? "";
  // The cursor the current update began from ('' = the first history download), or null when the
  // stored cursor is caught up. Kept in step with items.sync_start_cursor.
  let start = item.sync_start_cursor;
  let restarted = false;
  while (canSpend(budget)) {
    budget.pages--;
    let page: string;
    try {
      page = await plaidPostText(env, creds, "/transactions/sync",
        { access_token: accessToken, cursor: cursor || undefined, count: PAGE_SIZE });
    } catch (e) {
      const code = e instanceof PlaidError ? e.errorCode : "REQUEST_FAILED";
      console.error(`sync: item ${item.id}: ${e instanceof PlaidError ? `${code} (request ${e.requestId ?? "?"})` : String(e)}`);
      if (code === MUTATION && !restarted) {
        // Plaid: restart the whole update from the cursor it began with, not from this page. With
        // no start on record (an item mid-download from before migration 0004), that's the
        // beginning: a caught-up cursor can't be mid-update. Upserts are idempotent.
        restarted = true;
        cursor = start ?? "";
        start = cursor;
        await env.DB.prepare(RESTART_UPDATE).bind(item.id, cursor, code, (e as PlaidError).plaidMessage).run();
        continue;
      }
      // Anything else, or a second mutation this run: try again next run. Only item-level errors
      // change the status.
      const status = statusForError(e);
      await recordFailure(env, item.id, status, code, e instanceof PlaidError ? e.plaidMessage : null);
      return status ?? "retry";
    }

    if (budget.bytes !== undefined) budget.bytes -= page.length;
    let info: { next_cursor: string; has_more: number } | undefined;
    try {
      const results = await env.DB.batch([
        env.DB.prepare(STAGE_PAGE).bind(item.id, page),       // the only time the page leaves the Worker
        env.DB.prepare(UPSERT_ACCOUNTS).bind(item.id, item.owner),
        env.DB.prepare(UPSERT_TRANSACTIONS).bind(item.id, item.owner),
        env.DB.prepare(DELETE_REMOVED).bind(item.id),
        env.DB.prepare(ADVANCE_CURSOR).bind(item.id, cursor),
        env.DB.prepare(PAGE_INFO).bind(item.id),
        env.DB.prepare(UNSTAGE_PAGE).bind(item.id),
      ]);
      info = results[5].results[0] as typeof info;
    } catch (e) {
      console.error(`sync: item ${item.id}: saving a page failed: ${e instanceof Error ? e.message : e}`);
      await recordFailure(env, item.id, null, "SAVING_A_PAGE_FAILED").catch(() => {});
      return "retry";
    }
    if (!info) {
      console.error(`sync: item ${item.id}: Plaid returned a page that isn't valid sync JSON; will retry`);
      await recordFailure(env, item.id, null, "INVALID_SYNC_PAGE");
      return "retry";
    }
    start = info.has_more ? start ?? cursor : null;
    cursor = info.next_cursor;
    if (!info.has_more) return "good";
  }
  return "partial";
}

async function recordFailure(env: Env, itemId: number, status: string | null, code: string, plaidMessage: string | null = null): Promise<void> {
  await env.DB.prepare(RECORD_FAILURE).bind(itemId, status, code, plaidMessage).run();
}

// --- Daily connection check (Plaid /item/get) ------------------------------------------------
// Catches a connection Plaid already knows is broken before a sync fails, and records when a
// bank's consent through Plaid ends (some OAuth banks), so the dashboard can warn ahead of time.

export const CHECKS_PER_RUN = 1;          // one small Plaid call per hourly run: each bank about daily
const CHECK_EVERY = "-23 hours";

// Plaid says the Item is healthy: record the consent end (?2). A bank waiting for sign-in again is
// fine now (e.g. just reconnected), so it goes back to good and its sign-in error is cleared.
const CHECK_OK = `
  UPDATE items SET checked_at = ${NOW}, consent_expires_at = ?2,
    last_error = CASE WHEN status = 'login_required' THEN NULL ELSE last_error END,
    last_error_message = CASE WHEN status = 'login_required' THEN NULL ELSE last_error_message END,
    last_error_at = CASE WHEN status = 'login_required' THEN NULL ELSE last_error_at END,
    status = CASE WHEN status = 'login_required' THEN 'good' ELSE status END
  WHERE id = ?1`;

// Plaid reports an error on the Item: ?3 = new status (NULL keeps it), ?4 code, ?5 Plaid's text.
const CHECK_ERROR = `
  UPDATE items SET checked_at = ${NOW}, consent_expires_at = ?2, status = coalesce(?3, status),
    last_error = ?4, last_error_message = ?5, last_error_at = ${NOW}
  WHERE id = ?1`;

interface ItemGet {
  item: { error: { error_code?: string; display_message?: string; error_message?: string } | null; consent_expiration_time?: string | null };
}

/** Ask Plaid how one bank's connection is. Returns the code Plaid reported, null if healthy, or
 * "skipped" / "retry" when it couldn't be checked (nothing is recorded then). */
export async function checkItem(env: Env, config: Config, item: ItemRow): Promise<string | null | "skipped" | "retry"> {
  if (!config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account) || !env.TOKEN_ENC_KEY) return "skipped";
  let accessToken: string;
  try {
    accessToken = await fernetDecrypt(item.access_token_enc, env.TOKEN_ENC_KEY);
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    return "skipped";                     // sync reports this one
  }
  let got: ItemGet;
  try {
    got = (await plaidPost<ItemGet>(env, credsFor(env, config, item.plaid_account), "/item/get", { access_token: accessToken })).body;
  } catch (e) {
    if (!(e instanceof PlaidError)) {
      console.error(`check: item ${item.id}: ${String(e)}`);
      return "retry";
    }
    console.error(`check: item ${item.id}: ${e.errorCode} (request ${e.requestId ?? "?"})`);
    const status = statusForError(e);
    if (!status) return "retry";          // transient: check again next run
    await env.DB.prepare(CHECK_ERROR).bind(item.id, null, status, e.errorCode, e.plaidMessage).run();
    return e.errorCode;
  }
  const consent = typeof got.item?.consent_expiration_time === "string" ? got.item.consent_expiration_time : null;
  const err = got.item?.error;
  if (err?.error_code) {
    console.warn(`check: item ${item.id}: Plaid reports ${err.error_code}`);
    await env.DB.prepare(CHECK_ERROR).bind(item.id, consent, statusForCode(err.error_code), err.error_code, plaidMessageOf(err)).run();
    return err.error_code;
  }
  await env.DB.prepare(CHECK_OK).bind(item.id, consent).run();
  return null;
}

/** Check the banks least recently checked, up to `max`, about once a day each. Hourly cron only. */
export async function checkConnections(env: Env, max = CHECKS_PER_RUN): Promise<Record<number, string | null>> {
  const config = loadConfig(env);
  const { results: items } = await env.DB.prepare(
    `SELECT * FROM items WHERE status IN ('good', 'login_required')
       AND (checked_at IS NULL OR checked_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${CHECK_EVERY}'))
     ORDER BY checked_at IS NOT NULL, checked_at, id LIMIT ?`,
  ).bind(max).all<ItemRow>();
  const out: Record<number, string | null> = {};
  for (const item of items) out[item.id] = await checkItem(env, config, item);
  return out;
}

/** Sweep every syncable Item within one run's budget: caught-up banks first (one small page each),
 * then unfinished updates, each group least recently attempted first, so a failing bank goes to
 * the back instead of holding up the others. updatesOnly (the catch-up cron): only banks partway
 * through an update. Called only by the cron triggers (scheduled handler); there is no HTTP sync
 * endpoint. */
export async function runSyncAll(
  env: Env, budget: Budget = { pages: pagesPerRun(env), bytes: bytesPerRun(env) },
  opts: { updatesOnly?: boolean } = {},
): Promise<Record<number, ItemResult>> {
  const config = loadConfig(env);
  const { results: items } = await env.DB.prepare(
    `SELECT * FROM items WHERE status IN ('good', 'login_required')
     ${opts.updatesOnly ? "AND sync_start_cursor IS NOT NULL" : ""}
     ORDER BY sync_start_cursor IS NOT NULL, coalesce(attempted_at, updated_at), id`,
  ).all<ItemRow>();
  const out: Record<number, ItemResult> = {};
  for (const item of items) {
    if (!canSpend(budget)) break;
    out[item.id] = await syncItem(env, config, item, budget);
  }
  return out;
}
