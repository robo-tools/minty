import type { Env } from "./env";
import { credsFor, isConfigured, loadConfig, type Config } from "./config";
import { openAccessToken } from "./token-key";
import { PlaidError, plaidPost } from "./plaid";
import type { ItemRow } from "./sync";

// Separate invocation from transaction sync: preserve its small free-plan CPU budget.
export const LIABILITIES_CRON = "3,13,23,33,43,53 * * * *";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
type RecordValue = Record<string, unknown>;
const object = (v: unknown): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v as RecordValue : {};
const string = (v: unknown, max = 200) => typeof v === "string" ? v.slice(0, max) : null;
const cents = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(Math.round(v * 100)) ? Math.round(v * 100) : null;
const date = (v: unknown) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v ? v : null;
};

/** Persist only fields needed by the cards page, never the full Plaid response or Item metadata. */
export function cardRecords(payload: unknown): RecordValue[] {
  const root = object(payload), liabilities = object(root.liabilities);
  if (!Array.isArray(root.accounts) || !Object.keys(liabilities).length ||
      (liabilities.credit !== null && !Array.isArray(liabilities.credit))) throw new Error("INVALID_LIABILITIES_RESPONSE");
  const credit = (liabilities.credit ?? []) as unknown[];
  if (credit.length > 100 || root.accounts.length > 200) throw new Error("LIABILITIES_RESPONSE_TOO_LARGE");
  const accounts = new Map(root.accounts.map(a => { const row = object(a); return [row.account_id, row]; }));
  const seen = new Set<string>();
  return credit.map(value => {
    const row = object(value), id = string(row.account_id);
    const account = accounts.get(id), balances = object(account?.balances);
    if (!id || !account || seen.has(id)) throw new Error("INVALID_LIABILITIES_ACCOUNT");
    seen.add(id);
    const apr = Array.isArray(row.aprs) ? row.aprs.map(object).find(a => a.apr_type === "purchase_apr")?.apr_percentage : null;
    return {
      plaid_account_id: id, name: string(account.name) || "Credit account", mask: string(account.mask, 8),
      currency: string(balances.iso_currency_code, 3), current_balance_cents: cents(balances.current),
      credit_limit_cents: cents(balances.limit),
      statement_balance_cents: cents(row.last_statement_balance), statement_issue_date: date(row.last_statement_issue_date),
      minimum_payment_cents: cents(row.minimum_payment_amount), payment_due_date: date(row.next_payment_due_date),
      last_payment_cents: cents(row.last_payment_amount), last_payment_date: date(row.last_payment_date),
      purchase_apr: typeof apr === "number" && Number.isFinite(apr) && apr >= 0 ? apr : null,
      is_overdue: typeof row.is_overdue === "boolean" ? Number(row.is_overdue) : null,
    };
  });
}

const UPSERT_CARDS = `INSERT INTO card_liabilities (
  item_id, plaid_account_id, name, mask, currency, current_balance_cents, credit_limit_cents, statement_balance_cents,
  statement_issue_date, minimum_payment_cents, payment_due_date, last_payment_cents, last_payment_date,
  purchase_apr, is_overdue, available, observed_at)
  SELECT ?1, value ->> 'plaid_account_id', value ->> 'name', value ->> 'mask', value ->> 'currency',
    value ->> 'current_balance_cents', value ->> 'credit_limit_cents', value ->> 'statement_balance_cents', value ->> 'statement_issue_date',
    value ->> 'minimum_payment_cents', value ->> 'payment_due_date', value ->> 'last_payment_cents',
    value ->> 'last_payment_date', value ->> 'purchase_apr', value ->> 'is_overdue', 1, ?3
  FROM json_each(?2) WHERE true
  ON CONFLICT(item_id, plaid_account_id) DO UPDATE SET
    name=excluded.name, mask=excluded.mask, currency=excluded.currency,
    current_balance_cents=excluded.current_balance_cents, credit_limit_cents=excluded.credit_limit_cents,
    statement_balance_cents=excluded.statement_balance_cents,
    statement_issue_date=excluded.statement_issue_date, minimum_payment_cents=excluded.minimum_payment_cents,
    payment_due_date=excluded.payment_due_date, last_payment_cents=excluded.last_payment_cents,
    last_payment_date=excluded.last_payment_date, purchase_apr=excluded.purchase_apr,
    is_overdue=excluded.is_overdue, available=1, observed_at=excluded.observed_at`;

const SAVE_STATEMENTS = `INSERT INTO card_statements
  (account_id, issue_date, balance_cents, minimum_payment_cents, payment_due_date, currency, first_seen_at, last_seen_at)
  SELECT id, statement_issue_date, statement_balance_cents, minimum_payment_cents, payment_due_date, currency, ?2, ?2
    FROM card_liabilities WHERE item_id=?1 AND available=1 AND statement_issue_date IS NOT NULL
  ON CONFLICT(account_id, issue_date) DO UPDATE SET
    balance_cents=coalesce(excluded.balance_cents, card_statements.balance_cents),
    minimum_payment_cents=coalesce(excluded.minimum_payment_cents, card_statements.minimum_payment_cents),
    payment_due_date=coalesce(excluded.payment_due_date, card_statements.payment_due_date),
    currency=coalesce(excluded.currency, card_statements.currency), last_seen_at=excluded.last_seen_at`;

export async function saveLiabilities(env: Env, itemId: number, payload: unknown): Promise<void> {
  const records = JSON.stringify(cardRecords(payload)), observed = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE card_liabilities SET available=0 WHERE item_id=?").bind(itemId),
    env.DB.prepare(UPSERT_CARDS).bind(itemId, records, observed),
    env.DB.prepare(SAVE_STATEMENTS).bind(itemId, observed),
    env.DB.prepare(`UPDATE liability_sync SET status='ready', synced_at=?2, last_error=NULL,
      next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+24 hours') WHERE item_id=?1`).bind(itemId, observed),
  ]);
}

function failure(code: string): string {
  if (["ADDITIONAL_CONSENT_REQUIRED", "ACCESS_NOT_GRANTED", "ITEM_LOGIN_REQUIRED", "CONSENT_EXPIRED"].includes(code)) return "consent_required";
  if (["PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_SUPPORTED", "INVALID_PRODUCT", "ITEM_NOT_SUPPORTED", "NO_ACCOUNTS"].includes(code)) return "unsupported";
  return "error";
}

export async function syncLiabilities(env: Env, config: Config, item: ItemRow): Promise<string> {
  try {
    if (!isConfigured(env, config, item.plaid_account) || !env.TOKEN_ENC_KEY) throw new Error("CONFIGURATION_REQUIRED");
    const access = await openAccessToken(env, item);
    const response = await plaidPost<unknown>(env, credsFor(env, config, item.plaid_account), "/liabilities/get", { access_token: access });
    await saveLiabilities(env, item.id, response.body);
    return "ready";
  } catch (error) {
    // No exception messages or payloads: they may contain credentials or financial data.
    const code = error instanceof PlaidError ? error.errorCode : "LIABILITIES_SYNC_FAILED";
    const status = failure(code);
    await env.DB.prepare(`UPDATE liability_sync SET status=?2, last_error=?3,
      next_attempt_at=CASE WHEN ?2='error' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour') END WHERE item_id=?1`)
      .bind(item.id, status, code).run();
    return status;
  }
}

/** One due bank per ten-minute tick. Atomic lease prevents overlapping invocations fetching
 * the same bank. A crash releases the lease after ten minutes; success backs off for a day. */
export async function runLiabilitiesSync(env: Env): Promise<void> {
  const leased = await env.DB.prepare(`UPDATE liability_sync SET attempted_at=${NOW},
    next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes')
    WHERE item_id=(SELECT item_id FROM liability_sync WHERE next_attempt_at <= ${NOW}
      ORDER BY next_attempt_at, item_id LIMIT 1) RETURNING item_id`).first<{ item_id: number }>();
  if (!leased) return;
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?").bind(leased.item_id).first<ItemRow>();
  if (item) await syncLiabilities(env, loadConfig(env), item);
}
