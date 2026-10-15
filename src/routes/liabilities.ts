import type { Env } from "../env";
import { type Config, credsFor, isConfigured } from "../config";
import { fernetDecrypt } from "../fernet";
import { HttpError, dateParam, json, jsonBody, unprocessable } from "../http";
import { plaidPost } from "../plaid";
import type { ItemRow } from "../sync";
import { billBanks, CARDS_SQL, STATEMENTS_SQL, expandCard, overviewInputs, paymentWindow, paymentCoverage, boundedCoverage, type BillCard, type Statement } from "../bills-overview";
import { detectedPayments, summarizePayments } from "../statement-payments";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const ownerFilter = (config: Config, url: URL) => {
  const owner = url.searchParams.get("owner") || null;
  if (owner && !config.users.has(owner)) throw unprocessable("unknown owner");
  return owner;
};
const positiveId = (url: URL, key: string) => {
  const raw = url.searchParams.get(key) ?? "";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw unprocessable(`${key} must be a positive integer`);
  return Number(raw);
};
const validDate = (url: URL, key: string) => {
  const value = dateParam(url, key);
  if (value && new Date(value).toISOString().slice(0, 10) !== value) throw unprocessable(`${key} must be a real calendar date`);
  return value;
};

export async function overview(env: Env, config: Config, url: URL): Promise<Response> {
  const owner = ownerFilter(config, url);
  const [banks, { results: cards }, inputs] = await Promise.all([
    billBanks(env, config, owner),
    env.DB.prepare(`${CARDS_SQL} AND (?1 IS NULL OR i.owner=?1) ORDER BY c.payment_due_date IS NULL,c.payment_due_date,i.id,a.id`).bind(owner).all<BillCard>(),
    overviewInputs(env, owner),
  ]);
  const expanded = await Promise.all(cards.map(card => expandCard(env, card, banks.find(b => b.id === card.item_id),
    inputs.get(card.id!) ?? { window: { transactions: [], truncated: false }, dates: [] })));
  return json({ banks, cards: expanded });
}

async function getCard(env: Env, config: Config, url: URL, id: number) {
  const owner = ownerFilter(config, url);
  const card = await env.DB.prepare(`${CARDS_SQL} AND c.id=?1 AND (?2 IS NULL OR i.owner=?2)`).bind(id, owner).first<BillCard>();
  if (!card) throw new HttpError(404, "card not found");
  const bank = (await billBanks(env, config, owner)).find(b => b.id === card.item_id);
  return { card, bank };
}

export async function history(env: Env, config: Config, url: URL): Promise<Response> {
  const id = positiveId(url, "account_id"), before = validDate(url, "before") ?? null;
  const { card, bank } = await getCard(env, config, url, id);
  const { results } = await env.DB.prepare(`${STATEMENTS_SQL}
    WHERE h.account_id=?1 AND (?2 IS NULL OR h.issue_date < ?2) ORDER BY h.issue_date DESC LIMIT 51`).bind(id, before).all<Statement>();
  const page = results.slice(0, 50);
  const window = await paymentWindow(env, card, page.at(-1)?.issue_date ?? null, null);
  const statements = page.map(statement => ({ ...statement,
    payment_summary: summarizePayments(statement, statement.next_issue_date,
      window.transactions.filter(t => t.date > statement.issue_date && (!statement.next_issue_date || t.date <= statement.next_issue_date || t.amount_cents > 0)),
      boundedCoverage(paymentCoverage(card, bank, statement.issue_date), window.truncated),
      { last_payment_cents: card.last_payment_cents, last_payment_date: card.last_payment_date }),
  }));
  return json({ card: await expandCard(env, card, bank), statements, next_before: results.length > 50 ? results[49].issue_date : null });
}

/** Derived on every read, so Plaid corrections/removals take effect immediately. Cursor is
 * date:id, applied after classification/reversal checks on the bounded statement window. */
export async function payments(env: Env, config: Config, url: URL): Promise<Response> {
  const id = positiveId(url, "statement_id");
  const before = url.searchParams.get("before");
  if (before && !/^\d{4}-\d{2}-\d{2}:[1-9]\d*$/.test(before)) throw unprocessable("before must be a payment date:id cursor");
  if (before) {
    const [date, cursorId] = before.split(":");
    if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !Number.isSafeInteger(Number(cursorId))) throw unprocessable("invalid payment cursor");
  }
  const statement = await env.DB.prepare(`${STATEMENTS_SQL} WHERE h.id=?`).bind(id).first<Statement>();
  if (!statement) throw new HttpError(404, "statement not found");
  const { card, bank } = await getCard(env, config, url, statement.account_id);
  const window = await paymentWindow(env, card, statement.issue_date, null);
  const coverage = boundedCoverage(paymentCoverage(card, bank, statement.issue_date), window.truncated);
  const summary = summarizePayments(statement, statement.next_issue_date, window.transactions, coverage,
    { last_payment_cents: card.last_payment_cents, last_payment_date: card.last_payment_date });
  const detected = detectedPayments(statement, statement.next_issue_date, window.transactions)
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.id) - Number(a.id));
  const [date, cursorId] = before?.split(":") ?? [];
  const page = detected.filter(p => !before || p.date < date || (p.date === date && Number(p.id) < Number(cursorId))).slice(0, 51);
  const last = page[49];
  return json({ statement_id: id, issue_date: statement.issue_date, next_issue_date: statement.next_issue_date,
    payment_summary: summary, payments: page.slice(0, 50), next_before: page.length > 50 ? `${last.date}:${last.id}` : null });
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
