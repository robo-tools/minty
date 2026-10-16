import type { Env } from "./env";
import { type Config, credsFor, isConfigured, loadConfig } from "./config";
import { FernetError } from "./fernet";
import { openAccessToken } from "./token-key";
import { PlaidError, plaidPostText } from "./plaid";
import type { ItemRow } from "./sync";

/** Investment accounts from Plaid Investments (EGG, docs/cfa.md §3), for the banks the household
 * turned it on for: a retirement or brokerage login linked for Investments only, or a bank already
 * linked that was given the extra consent. Like statement details (src/statements.ts), the cron
 * fetches one due bank per catch-up run that had no download work, never on a request, and a
 * failure here is recorded on investment_sync only: it never changes items.status or the
 * transaction sync. Plaid's response text is bound once and SQLite unpacks it. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const INVESTMENT_REFRESH_HOURS = 24;
export const INVESTMENT_RETRY_HOURS = 1;
const NOT_READY_MINUTES = 30;                    // Plaid still preparing a new Item's investments
const MAX_RESPONSE_CHARS = 2_000_000;
const TXN_PAGE = 250;
const HISTORY_DAYS = 730;                        // Plaid keeps up to 24 months of investment transactions
const OVERLAP_DAYS = 30;                         // later fetches look back this far, for late corrections

/** Account subtypes that are retirement accounts (HSAs included, decided 2026-10-16): islanded in
 * EGG unless the household switches one back to the dashboard (accounts.view). */
export const RETIREMENT_SUBTYPES = ["401a", "401k", "403b", "457b", "ira", "roth", "roth 401k", "sep ira", "simple ira", "sarsep",
  "keogh", "pension", "retirement", "thrift savings plan", "profit sharing plan", "hsa", "rrsp", "rrif", "lira", "lrif", "lif", "prif", "rdsp", "sipp"];

/** SQL: whether account `a` shows in EGG instead of the dashboard. */
export const IN_RETIREMENT = (a: string) =>
  `(coalesce(${a}.view, CASE WHEN lower(coalesce(${a}.subtype, '')) IN (${RETIREMENT_SUBTYPES.map((s) => `'${s}'`).join(", ")}) THEN 'retirement' ELSE 'dashboard' END) = 'retirement')`;

// /investments/holdings/get: the bank's accounts (balances too), its securities, and what each
// account holds, which replaces what was there.
const SAVE_HOLDINGS = [
  `INSERT INTO accounts (owner, item_id, plaid_account_id, name, mask, type, subtype,
                         balance_current_cents, balance_available_cents, currency, updated_at)
   SELECT ?2, ?1, a.value ->> 'account_id', a.value ->> 'name', a.value ->> 'mask', a.value ->> 'type', a.value ->> 'subtype',
          CAST(round((a.value -> 'balances' ->> 'current') * 100) AS INTEGER),
          CAST(round((a.value -> 'balances' ->> 'available') * 100) AS INTEGER),
          a.value -> 'balances' ->> 'iso_currency_code', ${NOW}
   FROM json_each(?3, '$.accounts') a WHERE true
   ON CONFLICT (plaid_account_id) DO UPDATE SET
     name = excluded.name, mask = excluded.mask, type = excluded.type, subtype = excluded.subtype,
     balance_current_cents = excluded.balance_current_cents, balance_available_cents = excluded.balance_available_cents,
     currency = excluded.currency, updated_at = excluded.updated_at`,
  `INSERT INTO securities (security_id, name, ticker, type, is_cash_equivalent, close_price, close_price_as_of, updated_at)
   SELECT s.value ->> 'security_id', s.value ->> 'name', s.value ->> 'ticker_symbol', s.value ->> 'type',
          CASE json_type(s.value, '$.is_cash_equivalent') WHEN 'true' THEN 1 WHEN 'false' THEN 0 END,
          s.value ->> 'close_price', s.value ->> 'close_price_as_of', ${NOW}
   FROM json_each(?3, '$.securities') s WHERE s.value ->> 'security_id' IS NOT NULL
   ON CONFLICT (security_id) DO UPDATE SET name = excluded.name, ticker = excluded.ticker, type = excluded.type,
     is_cash_equivalent = excluded.is_cash_equivalent, close_price = coalesce(excluded.close_price, securities.close_price),
     close_price_as_of = coalesce(excluded.close_price_as_of, securities.close_price_as_of), updated_at = excluded.updated_at`,
  `DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE item_id = ?1)`,
  `INSERT INTO holdings (account_id, security_id, quantity, value_cents, cost_basis_cents, price, updated_at)
   SELECT acc.id, h.value ->> 'security_id', h.value ->> 'quantity',
          CAST(round((h.value ->> 'institution_value') * 100) AS INTEGER),
          CAST(round((h.value ->> 'cost_basis') * 100) AS INTEGER),
          h.value ->> 'institution_price', ${NOW}
   FROM json_each(?3, '$.holdings') h
   JOIN accounts acc ON acc.plaid_account_id = h.value ->> 'account_id' AND acc.item_id = ?1
   WHERE h.value ->> 'security_id' IS NOT NULL
   ON CONFLICT (account_id, security_id) DO UPDATE SET quantity = excluded.quantity, value_cents = excluded.value_cents,
     cost_basis_cents = excluded.cost_basis_cents, price = excluded.price`,
];

// /investments/transactions/get, one page: upserted, so a page fetched twice changes nothing.
const SAVE_TXNS = `
  INSERT INTO investment_txns (account_id, plaid_inv_txn_id, date, name, type, subtype, amount_cents, quantity, fees_cents, security_id)
  SELECT acc.id, t.value ->> 'investment_transaction_id', t.value ->> 'date', t.value ->> 'name', t.value ->> 'type', t.value ->> 'subtype',
         CAST(round((t.value ->> 'amount') * 100) AS INTEGER), t.value ->> 'quantity',
         CAST(round((t.value ->> 'fees') * 100) AS INTEGER), t.value ->> 'security_id'
  FROM json_each(?2, '$.investment_transactions') t
  JOIN accounts acc ON acc.plaid_account_id = t.value ->> 'account_id' AND acc.item_id = ?1
  WHERE (t.value ->> 'date') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ON CONFLICT (plaid_inv_txn_id) DO UPDATE SET date = excluded.date, name = excluded.name, type = excluded.type, subtype = excluded.subtype,
    amount_cents = excluded.amount_cents, quantity = excluded.quantity, fees_cents = excluded.fees_cents, security_id = excluded.security_id`;

// After a page: the next one, soon (more to fetch), or done until the daily refresh. ?2 is the
// next offset, or NULL when every page of the window is in.
const AFTER_PAGE = `UPDATE investment_sync SET status = 'ready', last_error = NULL, synced_at = ${NOW},
  txn_offset = coalesce(?2, 0),
  txn_start = CASE WHEN ?2 IS NULL THEN date('now', '-${OVERLAP_DAYS} days') ELSE txn_start END,
  next_attempt_at = CASE WHEN ?2 IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${INVESTMENT_REFRESH_HOURS} hours') ELSE ${NOW} END
  WHERE item_id = ?1`;

const FAILED = `UPDATE investment_sync SET status = ?2, last_error = ?3,
  next_attempt_at = CASE WHEN ?2 = 'error' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${INVESTMENT_RETRY_HOURS} hours')
                         WHEN ?2 = 'pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${NOT_READY_MINUTES} minutes') END
  WHERE item_id = ?1`;

/** Which investment_sync status a Plaid error code means: Plaid not ready yet (pending, tried again
 * in 30 minutes), consent needed or not supported (wait for the household), or retried in an hour. */
export function statusForInvestmentError(code: string): "pending" | "consent_required" | "unsupported" | "error" {
  if (code === "PRODUCT_NOT_READY") return "pending";
  if (["ADDITIONAL_CONSENT_REQUIRED", "ACCESS_NOT_GRANTED", "ITEM_LOGIN_REQUIRED", "CONSENT_EXPIRED", "INVALID_ACCESS_TOKEN"].includes(code)) return "consent_required";
  if (["PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_SUPPORTED", "INVALID_PRODUCT", "ITEM_NOT_SUPPORTED", "NO_INVESTMENT_ACCOUNTS", "NO_ACCOUNTS"].includes(code)) return "unsupported";
  return "error";
}

const tooLarge = (path: string) => new PlaidError(200, "API_ERROR", "RESPONSE_TOO_LARGE", undefined, `${path} response too large`);
const date = (offsetDays: number) => new Date(Date.now() + offsetDays * 864e5).toISOString().slice(0, 10);

/** Saves one /investments/holdings/get response (exported for tests). */
export async function saveHoldings(env: Env, item: Pick<ItemRow, "id" | "owner">, text: string): Promise<void> {
  if (text.length > MAX_RESPONSE_CHARS) throw tooLarge("/investments/holdings/get");
  // Each statement gets the values it uses (D1 refuses extra ones): the DELETE only needs the bank.
  await env.DB.batch(SAVE_HOLDINGS.map((q) => (q.startsWith("DELETE") ? env.DB.prepare(q).bind(item.id) : env.DB.prepare(q).bind(item.id, item.owner, text))));
}

/** Saves one page of /investments/transactions/get and moves the window on (exported for tests).
 * The total is read with a regular expression on the text: one number, so the Worker never parses
 * the page. */
export async function saveTxnPage(env: Env, itemId: number, offset: number, text: string): Promise<boolean> {
  if (text.length > MAX_RESPONSE_CHARS) throw tooLarge("/investments/transactions/get");
  const total = Number(/"total_investment_transactions"\s*:\s*(\d+)/.exec(text)?.[1] ?? 0);
  const next = offset + TXN_PAGE < total ? offset + TXN_PAGE : null;
  await env.DB.batch([env.DB.prepare(SAVE_TXNS).bind(itemId, text), env.DB.prepare(AFTER_PAGE).bind(itemId, next)]);
  return next !== null;
}

/** Fetches one bank's holdings and the next page of its investment transactions. Returns the
 * investment_sync status. */
export async function syncInvestments(env: Env, config: Config, item: ItemRow): Promise<string> {
  let code = "INVESTMENTS_FAILED";
  try {
    if (!config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account) || !env.TOKEN_ENC_KEY) {
      code = "CONFIGURATION_REQUIRED";
      throw new Error(code);
    }
    let accessToken: string;
    try {
      accessToken = await openAccessToken(env, item);
    } catch (e) {
      if (e instanceof FernetError) code = "INVALID_ACCESS_TOKEN";
      throw e;
    }
    const creds = credsFor(env, config, item.plaid_account);
    const state = await env.DB.prepare("SELECT txn_start, txn_offset FROM investment_sync WHERE item_id = ?").bind(item.id)
      .first<{ txn_start: string | null; txn_offset: number }>();
    const offset = state?.txn_offset ?? 0;
    if (offset === 0) await saveHoldings(env, item, await plaidPostText(env, creds, "/investments/holdings/get", { access_token: accessToken }));
    const text = await plaidPostText(env, creds, "/investments/transactions/get", {
      access_token: accessToken, start_date: state?.txn_start ?? date(-HISTORY_DAYS), end_date: date(0),
      options: { count: TXN_PAGE, offset },
    });
    await saveTxnPage(env, item.id, offset, text);
    return "ready";
  } catch (e) {
    if (e instanceof PlaidError) code = e.errorCode;
    console.error(`investments: item ${item.id}: ${code}`);          // only the code: Plaid's text may carry account details
    const status = statusForInvestmentError(code);
    await env.DB.prepare(FAILED).bind(item.id, status, code).run();
    return status;
  }
}

/** One due bank per call, leased like statement details. */
export async function runInvestmentSync(env: Env, config: Config = loadConfig(env)): Promise<Record<string, string>> {
  const leased = await env.DB.prepare(
    `UPDATE investment_sync SET attempted_at = ${NOW}, next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+10 minutes')
     WHERE item_id = (SELECT s.item_id FROM investment_sync s JOIN items i ON i.id = s.item_id
                      WHERE s.next_attempt_at IS NOT NULL AND s.next_attempt_at <= ${NOW} AND i.status = 'good'
                      ORDER BY s.next_attempt_at, s.item_id LIMIT 1)
     RETURNING item_id`).first<{ item_id: number }>();
  if (!leased) return {};
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(leased.item_id).first<ItemRow>();
  if (!item) return {};
  return { [item.id]: await syncInvestments(env, config, item) };
}
