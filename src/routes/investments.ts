import type { Env } from "../env";
import { type Config, credsFor, isConfigured } from "../config";
import { FernetError } from "../fernet";
import { openAccessToken } from "../token-key";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { plaidPost } from "../plaid";
import type { ItemRow } from "../sync";
import { IN_RETIREMENT } from "../investments";

/** EGG, phase E1 (docs/cfa.md §3): turning Investments on for a bank already linked (update-mode
 * Link, like statement details), the list of banks it's on for, and where an account shows. The
 * holdings themselves are fetched by the cron (src/investments.ts), never here. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  return b as Record<string, unknown>;
}

/** POST /link/investments/complete {session_id}: after update-mode Link for Investments. Link's
 * onSuccess is only a hint, so Plaid's /item/get must list investments among the bank's consented
 * products before it's turned on. Only this login's live session, claimed once. */
export async function completeInvestments(env: Env, config: Config, request: Request, email: string): Promise<Response> {
  const sessionId = (await objectBody(request)).session_id;
  if (typeof sessionId !== "string" || !sessionId) throw unprocessable("session_id is required");
  const valid = `id = ?1 AND email = ?2 AND operation = 'update' AND purpose = 'investments'
                 AND used_at IS NULL AND released_at IS NULL AND expires_at > ${NOW}`;
  const session = await env.DB.prepare(`SELECT item_id FROM link_sessions WHERE ${valid}`).bind(sessionId, email).first<{ item_id: number }>();
  if (!session) throw new HttpError(409, "This connection expired or was already finished. Start it again.");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(session.item_id).first<ItemRow>();
  if (!item) throw new HttpError(404, "bank not found");
  if (!env.TOKEN_ENC_KEY || !config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account)) {
    throw new HttpError(409, "This bank's Plaid keys aren't set up. Check Setup checks, then try again.");
  }
  let accessToken: string;
  try {
    accessToken = await openAccessToken(env, item);
  } catch (e) {
    if (!(e instanceof FernetError)) throw e;
    throw new HttpError(409, "This bank's stored token can't be decrypted with TOKEN_ENC_KEY (or TOKEN_ENC_KEY_PREVIOUS); link it again instead.");
  }
  const got = await plaidPost<{ item?: { consented_products?: string[]; products?: string[] } }>(
    env, credsFor(env, config, item.plaid_account), "/item/get", { access_token: accessToken });
  const products = [...(got.body.item?.consented_products ?? []), ...(got.body.item?.products ?? [])];
  if (!products.includes("investments")) {
    throw new HttpError(409, "Plaid hasn't confirmed access to this bank's investment accounts. Finish the bank's consent step, then try again.");
  }
  const [, claimed] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO investment_sync (item_id, status, next_attempt_at)
                    SELECT item_id, 'pending', ${NOW} FROM link_sessions WHERE ${valid}
                    ON CONFLICT (item_id) DO UPDATE SET status = 'pending', next_attempt_at = ${NOW}, last_error = NULL`).bind(sessionId, email),
    env.DB.prepare(`UPDATE link_sessions SET used_at = ${NOW}, finished_at = ${NOW} WHERE ${valid} RETURNING item_id`).bind(sessionId, email),
  ]);
  if (!claimed.results.length) throw new HttpError(409, "This connection was already finished.");
  return json({ item_id: item.id, investments: "pending" });
}

/** GET /investments: every bank, whether Investments is on for it (off, pending, ready,
 * consent_required, unsupported, error), and how many of its accounts show in EGG. One row per
 * bank, for the connect page. */
export async function investmentBanks(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT i.id AS item_id, i.institution_name AS bank, i.owner, i.products, coalesce(s.status, 'off') AS investments,
            s.synced_at, s.last_error,
            (SELECT count(*) FROM accounts a WHERE a.item_id = i.id AND ${IN_RETIREMENT("a")}) AS retirement_accounts,
            (SELECT count(*) FROM accounts a WHERE a.item_id = i.id AND a.type = 'investment') AS investment_accounts
     FROM items i LEFT JOIN investment_sync s ON s.item_id = i.id
     ORDER BY i.owner, i.id`).all();
  return json(results);
}

/** POST /investments/off {item_id}: stop fetching a bank's investments. What was saved stays. For an
 * Investments-only login that leaves nothing to fetch; disconnecting it is security plan step 5b. */
export async function investmentsOff(env: Env, request: Request): Promise<Response> {
  const itemId = (await objectBody(request)).item_id;
  if (!Number.isInteger(itemId)) throw unprocessable("item_id must be an integer");
  const r = await env.DB.prepare("DELETE FROM investment_sync WHERE item_id = ? RETURNING item_id").bind(itemId).first();
  return json({ item_id: itemId, investments: "off", changed: !!r });
}

/** PUT /accounts/{id}/view {view: 'dashboard' | 'retirement' | null}: where an account shows. null
 * goes back to the default (retirement accounts, HSAs included, in EGG). */
export async function setAccountView(env: Env, request: Request, id: number): Promise<Response> {
  const view = (await objectBody(request)).view;
  if (view !== null && view !== "dashboard" && view !== "retirement") throw unprocessable("view must be 'dashboard', 'retirement' or null");
  const r = await env.DB.prepare(`UPDATE accounts SET view = ? WHERE id = ? RETURNING id, ${IN_RETIREMENT("accounts")} AS in_retirement`)
    .bind(view, id).first<{ id: number; in_retirement: number }>();
  if (!r) throw new HttpError(404, "account not found");
  return json({ id, view, in_retirement: Boolean(r.in_retirement) });
}
