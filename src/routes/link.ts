import type { Env } from "../env";
import { type Config, ConfigError, credsFor, isConfigured, secretNames } from "../config";
import { FernetError, fernetEncrypt } from "../fernet";
import { openAccessToken } from "../token-key";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { PlaidError, plaidPost } from "../plaid";
import { type ItemRow, checkItem, syncItem } from "../sync";
import { BANK_ROWS_SQL, type BankRow, bankHealth } from "../health";

/** Plaid Link flow: /link/token -> Link in the browser ->
 * /link/exchange (stores the encrypted access token, starts the first sync in the background).
 * /link/token/update opens Link in update mode to repair an Item (e.g. login_required).
 *
 * Link sessions (migration 0009, docs/security-plan.md step 3): /link/token reserves a slot under
 * the Trial cap for the signed-in login, in one statement per slot, so two people linking at once
 * can't both take the last one. /link/exchange claims that session once, before Plaid's exchange
 * (on Trial every access token uses a slot for good), and takes owner and plaid_account from it,
 * never from the browser. /link/cancel releases it. */

// First sync inside the /link/exchange request, which also does the token exchange and has the
// same 10 ms CPU limit on the free plan: one page. The rest of the backfill happens on cron runs.
const FIRST_SYNC = { pages: 1, bytes: 150_000 };
const HISTORY_DAYS = 730;            // ask for up to 24 months (Plaid's default is 90 days)
export const SESSION_MINUTES = 30;   // a Link session (and its reservation) lasts this long
export const UPDATE_COOLDOWN_SECONDS = 60;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A 'link' session that still counts against its slot: open (not used, released or expired), or
 * claimed and not finished (Plaid may already have created the access token). */
export const RESERVED = `s.operation = 'link' AND s.released_at IS NULL AND s.finished_at IS NULL
                AND (s.used_at IS NOT NULL OR s.expires_at > ${NOW})`;
/** Banks plus reservations on one credential set (?1). */
const USED_SQL = `(SELECT count(*) FROM items WHERE plaid_account = ?1)
                + (SELECT count(*) FROM link_sessions s WHERE s.plaid_account = ?1 AND ${RESERVED})`;

function newSessionId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const expiry = () => new Date(Date.now() + SESSION_MINUTES * 60_000).toISOString();

async function release(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`UPDATE link_sessions SET released_at = ${NOW} WHERE id = ? AND finished_at IS NULL AND released_at IS NULL`)
    .bind(sessionId).run();
}

function sessionIdOf(b: Record<string, unknown>): string {
  const v = b.session_id;
  if (typeof v !== "string" || !v) throw unprocessable("Link session missing: reload the page and start the connection again.");
  return v;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await jsonBody(request);
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;          // too large
  }
  throw unprocessable("body must be a JSON object");
}

function str(b: Record<string, unknown>, name: string): string {
  const v = b[name];
  if (typeof v !== "string" || !v) throw unprocessable(`${name} is required`);
  return v;
}

function tokenKey(env: Env): string {
  if (!env.TOKEN_ENC_KEY) {
    throw new ConfigError("TOKEN_ENC_KEY is not set. Add it as a Worker secret: npx wrangler secret put TOKEN_ENC_KEY");
  }
  return env.TOKEN_ENC_KEY;
}

function linkBase(env: Env, owner: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    client_name: "Minty",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: owner },
  };
  const redirect = env.PLAID_REDIRECT_URI?.trim();
  if (redirect) base.redirect_uri = redirect;       // omitted entirely when unset (Plaid rejects an empty one)
  return base;
}

/** Banks on a credential set plus its open reservations (Link sessions that still count). */
export async function countItems(env: Env, plaidAccount: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT ${USED_SQL} AS n`).bind(plaidAccount).first<{ n: number }>();
  return row?.n ?? 0;
}

/** This person's first credential slot (PLAID_SLOTS order) that has keys and is under the Item
 * cap, counting reservations. Slots without keys are skipped, so people can have different
 * numbers of Plaid accounts. Never another person's. It only reads: /link/token reserves with
 * reserveSlot, and uses this for the error when nothing is free. */
export async function chooseAccountFor(env: Env, config: Config, owner: string): Promise<string> {
  let firstWithoutKeys: string | undefined;
  for (const key of config.ownerAccounts.get(owner) ?? []) {
    if (!isConfigured(env, config, key)) {
      firstWithoutKeys ??= key;
      continue;
    }
    if ((await countItems(env, key)) < config.itemCap) return key;
  }
  if (firstWithoutKeys) {
    const n = secretNames(firstWithoutKeys);
    throw new HttpError(400,
      `No Plaid account for '${owner}' has room: every slot with keys is at the ${config.itemCap}-item cap ` +
      `or none has keys yet. Add keys for '${firstWithoutKeys}': Worker secrets ${n.clientId} and ${n.secret} ` +
      `(npx wrangler secret put ${n.clientId}).`);
  }
  throw new HttpError(409,
    `All Plaid trial accounts for '${owner}' are at the ${config.itemCap}-item cap. ` +
    "Add another slot to PLAID_SLOTS (with its keys) or upgrade to a paid Plaid plan.");
}

/** Reserves a slot for `owner`: the first slot in PLAID_SLOTS order that has keys and room (banks
 * plus reservations under the cap). Each try is one statement, so concurrent reservations can't
 * overshoot. Nothing free: chooseAccountFor's error (no keys yet / every slot full). */
async function reserveSlot(env: Env, config: Config, owner: string, email: string, purpose: LinkPurpose = "reconnect"): Promise<{ account: string; id: string; expires: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const account of config.ownerAccounts.get(owner) ?? []) {
      if (!isConfigured(env, config, account)) continue;
      const id = newSessionId(), expires = expiry();
      const row = await env.DB.prepare(
        `INSERT INTO link_sessions (id, email, operation, owner, plaid_account, expires_at, purpose)
         SELECT ?2, ?3, 'link', ?4, ?1, ?5, ?7 WHERE ${USED_SQL} < ?6 RETURNING id`,
      ).bind(account, id, email, owner, expires, config.itemCap, purpose).first<{ id: string }>();
      if (row) return { account, id, expires };
    }
    await chooseAccountFor(env, config, owner);        // throws why nothing is free; a slot freed meanwhile: try again
  }
  throw new HttpError(409, `Every Plaid account for '${owner}' is busy: other banks are being linked right now. Try again in a few minutes.`);
}

/** A new link's purpose (link_sessions.purpose): a bank for its transactions (the default, stored as
 * 'reconnect' like every session before it), or a retirement or brokerage login for Plaid
 * Investments only (EGG, docs/cfa.md §3). */
type LinkPurpose = "reconnect" | "investments";

export async function createLinkToken(env: Env, config: Config, request: Request, email: string): Promise<Response> {
  const b = await body(request);
  const owner = b.owner;
  if (typeof owner !== "string" || !config.users.has(owner)) throw new HttpError(400, "unknown owner");
  if (b.kind !== undefined && b.kind !== "transactions" && b.kind !== "investments") throw unprocessable("kind must be 'transactions' or 'investments'");
  const investments = b.kind === "investments";
  const session = await reserveSlot(env, config, owner, email, investments ? "investments" : "reconnect");   // overflow decision happens here
  try {
    const { body: resp } = await plaidPost<{ link_token: string }>(env, credsFor(env, config, session.account), "/link/token/create", {
      ...linkBase(env, owner),
      ...(investments ? { products: ["investments"] } : { products: ["transactions"], transactions: { days_requested: HISTORY_DAYS } }),
    });
    // The session ties /link/exchange to the SAME credentials; plaid_account is for the page's display.
    return json({ link_token: resp.link_token, plaid_account: session.account, session_id: session.id, expires_at: session.expires });
  } catch (e) {
    await release(env, session.id).catch(() => {});     // no link token: the reservation goes back
    throw e;
  }
}

/** Why a session couldn't be claimed, for the page. One read, only on failure. */
async function unclaimable(env: Env, sessionId: string, email: string): Promise<HttpError> {
  const s = await env.DB.prepare(
    `SELECT email, operation, used_at, released_at, expires_at <= ${NOW} AS expired FROM link_sessions WHERE id = ?`)
    .bind(sessionId).first<{ email: string; operation: string; used_at: string | null; released_at: string | null; expired: number }>();
  if (!s || s.email !== email || s.operation !== "link") return new HttpError(409, "Unknown Link session: reload the page and start the connection again.");
  if (s.used_at) return new HttpError(409, "This connection was already completed. Reload the page to see it.");
  if (s.released_at) return new HttpError(409, "This connection was cancelled. Start it again.");
  return new HttpError(409, `This connection expired (after ${SESSION_MINUTES} minutes). Start it again.`);
}

export async function exchange(env: Env, config: Config, request: Request, ctx: ExecutionContext, email: string): Promise<Response> {
  const b = await body(request);
  const sessionId = sessionIdOf(b);
  const publicToken = str(b, "public_token");
  const institution = typeof b.institution_name === "string" ? b.institution_name.slice(0, 200) : null;
  const key = tokenKey(env);

  // Claim the session (once, this login, unexpired) before Plaid creates an access token.
  // owner and plaid_account come from it; anything the browser sends for them is ignored.
  const session = await env.DB.prepare(
    `UPDATE link_sessions SET used_at = ${NOW}
     WHERE id = ? AND email = ? AND operation = 'link' AND used_at IS NULL AND released_at IS NULL AND expires_at > ${NOW}
     RETURNING owner, plaid_account, purpose`).bind(sessionId, email).first<{ owner: string; plaid_account: string; purpose: string }>();
  if (!session) throw await unclaimable(env, sessionId, email);
  const { owner, plaid_account: plaidAccount } = session;
  const investments = session.purpose === "investments";
  if (!config.accountOwner.has(plaidAccount) || config.accountOwner.get(plaidAccount) !== owner) {
    await release(env, sessionId);                       // that person or slot was removed meanwhile
    throw new HttpError(400, "unknown plaid_account");
  }

  let resp: { access_token: string; item_id: string };
  try {
    ({ body: resp } = await plaidPost<{ access_token: string; item_id: string }>(
      env, credsFor(env, config, plaidAccount), "/item/public_token/exchange", { public_token: publicToken }));
  } catch (e) {
    // Plaid answered with an error: no access token, nothing spent. Anything else (the request
    // may have reached Plaid) keeps the session counting.
    if (e instanceof PlaidError) await release(env, sessionId).catch(() => {});
    throw e;
  }
  const enc = await fernetEncrypt(resp.access_token, key);

  // Re-linking the same Plaid Item refreshes its token instead of failing on the unique key.
  // Storing the bank and finishing the session are one batch: the reservation becomes the item.
  // An Investments-only login gets its holdings from the cron's investments fetch (within about
  // 10 minutes) instead of a first transaction sync.
  const [stored] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name,
                          transactions_history_requested_start_date, products)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'transactions' THEN date('now', '-${HISTORY_DAYS} days') END, ?)
       ON CONFLICT (plaid_item_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc, status = 'good',
         institution_name = COALESCE(excluded.institution_name, items.institution_name),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       RETURNING *`,
    ).bind(owner, plaidAccount, resp.item_id, enc, institution, investments ? "investments" : "transactions", investments ? "investments" : "transactions"),
    env.DB.prepare(`UPDATE link_sessions SET finished_at = ${NOW}, item_id = (SELECT id FROM items WHERE plaid_item_id = ?) WHERE id = ?`)
      .bind(resp.item_id, sessionId),
    env.DB.prepare(`INSERT INTO investment_sync (item_id, status, next_attempt_at)
                    SELECT id, 'pending', ${NOW} FROM items WHERE plaid_item_id = ? AND ?
                    ON CONFLICT (item_id) DO UPDATE SET status = 'pending', next_attempt_at = ${NOW}, last_error = NULL`)
      .bind(resp.item_id, investments ? 1 : 0),
  ]);
  const item = (stored.results as unknown as ItemRow[])[0];

  // Initial backfill in the background; the response doesn't wait for it.
  if (!investments) {
    ctx.waitUntil(syncItem(env, config, item!, { ...FIRST_SYNC }).catch((e) =>
      console.error(`first sync of item ${item!.id} failed:`, e instanceof Error ? e.message : e)));
  }
  return json({ item_id: item!.id, plaid_account: plaidAccount, status: item!.status });
}

/** POST /link/reconnected: after Link update mode succeeds, ask Plaid how the connection is now
 * (the daily /item/get check, done right away), so the warning clears without waiting a day.
 * No transactions are synced here: that stays with the cron triggers. */
export async function reconnected(env: Env, config: Config, request: Request): Promise<Response> {
  const itemId = (await body(request)).item_id;
  if (!Number.isInteger(itemId)) throw unprocessable("item_id must be an integer");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(itemId).first<ItemRow>();
  if (!item) throw new HttpError(404, "item not found");
  const result = await checkItem(env, config, item);
  const row = await env.DB.prepare(`${BANK_ROWS_SQL} WHERE i.id = ?`).bind(itemId).first<BankRow>();
  return json({ item_id: item.id, checked: result !== "skipped" && result !== "retry", health: bankHealth(env, config, row!) });
}

/** POST /link/cancel {session_id}: Link was closed without finishing, so the reservation goes back
 * (or a reconnect's cooldown ends). Only this login's session, and only if it wasn't used. */
export async function cancel(env: Env, request: Request, email: string): Promise<Response> {
  const sessionId = sessionIdOf(await body(request));
  const r = await env.DB.prepare(
    `UPDATE link_sessions SET released_at = ${NOW} WHERE id = ? AND email = ? AND used_at IS NULL AND released_at IS NULL RETURNING id`)
    .bind(sessionId, email).first();
  return json({ session_id: sessionId, released: !!r });
}

/** Hourly cron: drop sessions a week past their expiry, except a claimed one that never finished
 * (it keeps counting against its slot: Plaid may have kept that connection). */
export async function pruneLinkSessions(db: D1Database): Promise<void> {
  await db.prepare(
    `DELETE FROM link_sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
     AND NOT (operation = 'link' AND used_at IS NOT NULL AND finished_at IS NULL AND released_at IS NULL)`).run();
}

/** Update-mode Link for an existing bank: a reconnect; "liabilities", which also asks the bank
 * for Liabilities consent (docs/bills.md); or "investments", which asks for Investments consent
 * (EGG). Each reuses the Item, so no Trial slot. */
export type UpdatePurpose = "reconnect" | "liabilities" | "investments";

export async function updateMode(env: Env, config: Config, request: Request, email: string, purpose: UpdatePurpose = "reconnect"): Promise<Response> {
  const itemId = (await body(request)).item_id;
  if (!Number.isInteger(itemId)) throw unprocessable("item_id must be an integer");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(itemId).first<ItemRow>();
  if (!item) throw new HttpError(404, "item not found");
  if (!config.accountOwner.has(item.plaid_account)) throw new HttpError(400, "item's plaid_account is not configured");
  let accessToken: string;
  try {
    tokenKey(env);                        // a clear error when TOKEN_ENC_KEY isn't set
    accessToken = await openAccessToken(env, item);
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    throw new HttpError(409, "This bank's stored token can't be decrypted with TOKEN_ENC_KEY (or TOKEN_ENC_KEY_PREVIOUS); link it again instead.");
  }
  // One reconnect per bank a minute (a cancelled one doesn't count): each makes a Plaid link token.
  const id = newSessionId(), expires = expiry();
  const opened = await env.DB.prepare(
    `INSERT INTO link_sessions (id, email, operation, owner, plaid_account, item_id, expires_at, purpose)
     SELECT ?, ?, 'update', ?, ?, ?, ?, ? WHERE NOT EXISTS (
       SELECT 1 FROM link_sessions WHERE item_id = ? AND operation = 'update' AND released_at IS NULL
       AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${UPDATE_COOLDOWN_SECONDS} seconds'))
     RETURNING id`).bind(id, email, item.owner, item.plaid_account, item.id, expires, purpose, item.id).first();
  if (!opened) {
    const what = { liabilities: "Turning on statement details for", investments: "Adding investment accounts from", reconnect: "Reconnecting" }[purpose];
    throw new HttpError(429, `${what} this bank was started less than a minute ago. Finish or close that one, or wait a minute.`);
  }
  try {
    const { body: resp } = await plaidPost<{ link_token: string }>(env, credsFor(env, config, item.plaid_account), "/link/token/create", {
      ...linkBase(env, item.owner),
      access_token: accessToken,          // update mode; no products
      ...(purpose === "liabilities" ? { additional_consented_products: ["liabilities"] }
        : purpose === "investments" ? { additional_consented_products: ["investments"] } : {}),
    });
    return json({ link_token: resp.link_token, plaid_account: item.plaid_account, session_id: id, expires_at: expires });
  } catch (e) {
    await release(env, id).catch(() => {});
    throw e;
  }
}
