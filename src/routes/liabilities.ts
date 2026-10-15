import type { Env } from "../env";
import { type Config, credsFor, isConfigured } from "../config";
import { fernetDecrypt } from "../fernet";
import { HttpError, dateParam, json, jsonBody, unprocessable } from "../http";
import { plaidPost } from "../plaid";
import type { ItemRow } from "../sync";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const CARD_FIELDS = `c.id, c.item_id, c.name, c.mask, c.currency, c.current_balance_cents,
  c.statement_balance_cents, c.statement_issue_date, c.minimum_payment_cents, c.payment_due_date,
  c.last_payment_cents, c.last_payment_date, c.purchase_apr, c.is_overdue, c.available, c.observed_at`;

export async function overview(env: Env, config: Config, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner") || null;
  if (owner && !config.users.has(owner)) throw unprocessable("unknown owner");
  const [banks, cards] = await env.DB.batch([
    env.DB.prepare(`SELECT i.id, i.owner, i.institution_name, i.plaid_account,
      coalesce(s.status, 'disabled') AS status, s.enabled_at, s.attempted_at, s.synced_at, s.last_error
      FROM items i LEFT JOIN liability_sync s ON s.item_id=i.id WHERE (?1 IS NULL OR i.owner=?1) ORDER BY i.id`).bind(owner),
    env.DB.prepare(`SELECT ${CARD_FIELDS}, i.owner, i.institution_name,
      (SELECT count(*) FROM card_statements h WHERE h.account_id=c.id) AS statement_count
      FROM card_liabilities c JOIN items i ON i.id=c.item_id
      WHERE (?1 IS NULL OR i.owner=?1) ORDER BY c.available DESC, c.payment_due_date IS NULL, c.payment_due_date, c.id`).bind(owner),
  ]);
  return json({ banks: (banks.results as Record<string, unknown>[]).map(row => {
    const { plaid_account, ...publicRow } = row;
    const key = String(plaid_account);
    return { ...publicRow, configured: config.accountOwner.has(key) && isConfigured(env, config, key) };
  }), cards: cards.results });
}

export async function history(env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("account_id") ?? "";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw unprocessable("account_id must be a positive integer");
  const id = Number(raw), before = dateParam(url, "before") ?? null;
  const card = await env.DB.prepare(`SELECT ${CARD_FIELDS}, i.institution_name FROM card_liabilities c
    JOIN items i ON i.id=c.item_id WHERE c.id=?`).bind(id).first();
  if (!card) throw new HttpError(404, "card not found");
  const { results } = await env.DB.prepare(`SELECT issue_date, balance_cents, minimum_payment_cents,
    payment_due_date, currency, first_seen_at, last_seen_at FROM card_statements
    WHERE account_id=?1 AND (?2 IS NULL OR issue_date < ?2) ORDER BY issue_date DESC LIMIT 51`).bind(id, before).all();
  return json({ card, statements: results.slice(0, 50), next_before: results.length > 50 ? results[49].issue_date : null });
}

/** onSuccess is only a hint. Verify consent directly with Plaid, then atomically consume this
 * login's live, purpose-bound session and queue polling. Never exchange or create another Item. */
export async function complete(env: Env, config: Config, request: Request, email: string): Promise<Response> {
  let body: unknown;
  try { body = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw unprocessable("body must be a JSON object");
  }
  const id = body && typeof body === "object" && "session_id" in body ? body.session_id : null;
  if (typeof id !== "string" || !id) throw unprocessable("session_id is required");
  const valid = `id=?1 AND email=?2 AND operation='update' AND purpose='liabilities'
    AND used_at IS NULL AND released_at IS NULL AND expires_at > ${NOW}`;
  const session = await env.DB.prepare(`SELECT item_id FROM link_sessions WHERE ${valid}`).bind(id, email).first<{ item_id: number }>();
  if (!session) throw new HttpError(409, "This statement connection expired or was already completed. Start it again.");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(session.item_id).first<ItemRow>();
  if (!item) throw new HttpError(404, "bank not found");
  if (!env.TOKEN_ENC_KEY || !config.accountOwner.has(item.plaid_account) || !isConfigured(env, config, item.plaid_account)) {
    throw new HttpError(409, "This bank's Plaid keys are not configured. Check setup before trying again.");
  }
  const access = await fernetDecrypt(item.access_token_enc, env.TOKEN_ENC_KEY);
  const result = await plaidPost<{ item?: { consented_products?: string[] } }>(env, credsFor(env, config, item.plaid_account), "/item/get", { access_token: access });
  if (!result.body.item?.consented_products?.includes("liabilities")) {
    throw new HttpError(409, "Plaid has not confirmed access to statement details. Complete the consent step and retry.");
  }
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO liability_sync (item_id, status, enabled_at, next_attempt_at)
      SELECT item_id, 'pending', ${NOW}, ${NOW} FROM link_sessions WHERE ${valid}
      ON CONFLICT(item_id) DO UPDATE SET status='pending', next_attempt_at=${NOW}, last_error=NULL`).bind(id, email),
    env.DB.prepare(`UPDATE link_sessions SET used_at=${NOW}, finished_at=${NOW}
      WHERE ${valid} RETURNING item_id`).bind(id, email),
  ]);
  if (!results[1].results.length) throw new HttpError(409, "This statement connection was already completed.");
  return json({ item_id: item.id, status: "pending" });
}
