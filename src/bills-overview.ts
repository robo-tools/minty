import type { Env } from "./env";
import { type Config, isConfigured } from "./config";
import { bankHealth, bankRows, type Health } from "./health";
import { currentUtilization, forecastStatementDate, summarizePayments, type PaymentCoverage, type PaymentTransaction } from "./statement-payments";
import { isChargeCard } from "./card-type";

export const STATEMENT_STALE_HOURS = 30;
const MAX_WINDOW_TRANSACTIONS = 5000;
// Only expose app-defined verdicts, never arbitrary failure text or verification payloads.
const HISTORY_VERIFICATION_CODES = new Set([
  "SOURCE_NOT_READY", "SOURCE_ITEM_MISMATCH", "SOURCE_ITEM_ERROR", "SOURCE_ITEM_STATUS_MISSING",
  "SOURCE_MARKER_MISSING", "SOURCE_MARKER_INVALID", "SOURCE_MARKER_FUTURE", "SOURCE_MARKER_STALE",
  "SOURCE_FAILURE_MARKER_INVALID", "SOURCE_UPDATE_FAILED", "SOURCE_CHANGED", "TRANSACTIONS_NOT_READY",
  "HISTORY_PAGE_INVALID", "HISTORY_ITEM_MISMATCH", "HISTORY_ITEM_ERROR", "HISTORY_ACCOUNTS_CHANGED",
  "HISTORY_ACCOUNT_OWNER_CHANGED", "HISTORY_SAVED_CREDIT_ACCOUNT_MISSING", "HISTORY_SOURCE_ACCOUNT_INVALID",
  "HISTORY_SOURCE_ACCOUNT_UNKNOWN", "HISTORY_UNREQUESTED_TRANSACTION", "HISTORY_DUPLICATE_TRANSACTIONS", "HISTORY_TRANSACTION_MISSING",
  "HISTORY_TRANSACTION_OWNER_CHANGED", "HISTORY_TRANSACTION_INVALID", "HISTORY_AMOUNT_CHANGED",
  "HISTORY_CURRENCY_CHANGED", "HISTORY_DATE_CHANGED", "HISTORY_NAME_CHANGED", "HISTORY_MERCHANT_CHANGED",
  "HISTORY_PENDING_CHANGED", "HISTORY_CLASSIFICATION_CHANGED", "HISTORY_TOTAL_CHANGED", "HISTORY_PAGE_MISSING",
  "HISTORY_MISMATCH", "PAYMENT_CLASSIFICATION_CHANGED", "LOCAL_DATA_CHANGED", "VERIFICATION_EXPIRED",
  "VERIFICATION_FAILED", "STATEMENT_WINDOW_UNAVAILABLE", "ITEM_UNAVAILABLE",
]);
export interface BillBank {
  id: number; owner: string; institution_name: string | null; status: string;
  enabled_at: string | null; attempted_at: string | null; synced_at: string | null; last_error: string | null;
  transactions_update_status: string | null; transactions_history_start_date: string | null;
  transactions_verified_start_date?: string | null; transactions_verified_end_date?: string | null; transactions_verified_at?: string | null;
  history_verification_status: "active" | "failed" | null;
  history_verification_code: string | null;
  downloading: number; synced_once: number; configured: boolean; health: Health;
}
export interface BillCard {
  id: number | null; item_id: number; owner: string; institution_name: string | null;
  transaction_account_id: number | null; name: string; mask: string | null; currency: string | null;
  nickname: string | null; display_mask: string | null;
  current_balance_cents: number | null; credit_limit_cents: number | null; balance_updated_at: string | null;
  statement_balance_cents: number | null; statement_issue_date: string | null; minimum_payment_cents: number | null;
  payment_due_date: string | null; last_payment_cents: number | null; last_payment_date: string | null;
  purchase_apr: number | null; is_overdue: number | null; available: number; observed_at: string | null;
  statement_count: number; statement_id: number | null; next_issue_date: string | null;
}
export interface Statement {
  id: number; account_id: number; issue_date: string; balance_cents: number | null;
  minimum_payment_cents: number | null; payment_due_date: string | null; currency: string | null;
  first_seen_at: string; last_seen_at: string; next_issue_date: string | null;
}

/** Combine the existing transaction-health verdict with the separately polled statement status. */
export async function billBanks(env: Env, config: Config, owner: string | null): Promise<BillBank[]> {
  const [healthRows, { results }] = await Promise.all([
    bankRows(env),
    env.DB.prepare(`SELECT i.id, coalesce(s.status, 'disabled') AS status, s.enabled_at,
      s.attempted_at, s.synced_at, s.last_error, i.transactions_update_status, i.transactions_history_start_date,
      i.transactions_verified_start_date,i.transactions_verified_end_date,i.transactions_verified_at,
      CASE WHEN v.status='active' AND v.expires_at<=?2 THEN 'failed'
        ELSE v.status END AS history_verification_status,
      CASE WHEN v.status='active' AND v.expires_at<=?2 THEN 'VERIFICATION_EXPIRED'
        WHEN v.status='failed' THEN v.failure_code END AS history_verification_code
      FROM items i LEFT JOIN liability_sync s ON s.item_id=i.id
      LEFT JOIN history_verifications v ON v.item_id=i.id AND v.status IN ('active','failed')
      WHERE (?1 IS NULL OR i.owner=?1) ORDER BY i.id`).bind(owner, Date.now()).all(),
  ]);
  return results.map(row => {
    const bank = healthRows.find(b => b.id === row.id)!;
    const verificationCode = row.history_verification_code;
    return { ...row,
      history_verification_code: row.history_verification_status === "failed"
        ? typeof verificationCode === "string" && HISTORY_VERIFICATION_CODES.has(verificationCode) ? verificationCode : "VERIFICATION_FAILED"
        : null,
      id: bank.id, owner: bank.owner, institution_name: bank.institution_name,
      downloading: bank.downloading, synced_once: bank.synced_once,
      configured: config.accountOwner.has(bank.plaid_account) && isConfigured(env, config, bank.plaid_account),
      health: bankHealth(env, config, bank) } as BillBank;
  });
}

// A statement card keeps its original id. Account-only cards have id=null and cannot request
// statement history. A FULL JOIN also preserves old statements when an account disappears.
export const CARDS_SQL = `SELECT c.id, coalesce(c.item_id,a.item_id) AS item_id, i.owner, i.institution_name,
  a.id AS transaction_account_id, coalesce(a.name,c.name,'Credit account') AS name, coalesce(a.mask,c.mask) AS mask,
  p.nickname, p.display_mask,
  CASE WHEN a.id IS NOT NULL AND (c.observed_at IS NULL OR a.updated_at > c.observed_at)
    THEN a.currency ELSE c.currency END AS currency,
  CASE WHEN a.id IS NOT NULL AND (c.observed_at IS NULL OR a.updated_at > c.observed_at)
    THEN a.balance_current_cents ELSE c.current_balance_cents END AS current_balance_cents,
  CASE WHEN a.id IS NOT NULL AND (c.observed_at IS NULL OR a.updated_at > c.observed_at)
    THEN a.credit_limit_cents ELSE c.credit_limit_cents END AS credit_limit_cents,
  CASE WHEN a.id IS NOT NULL AND (c.observed_at IS NULL OR a.updated_at > c.observed_at)
    THEN a.updated_at ELSE c.observed_at END AS balance_updated_at,
  c.currency AS statement_currency, c.statement_balance_cents, c.statement_issue_date, c.minimum_payment_cents,
  c.payment_due_date, c.last_payment_cents, c.last_payment_date, c.purchase_apr, c.is_overdue,
  coalesce(c.available,0) AS available, c.observed_at,
  (SELECT count(*) FROM card_statements h WHERE h.account_id=c.id) AS statement_count,
  (SELECT h.id FROM card_statements h WHERE h.account_id=c.id AND h.issue_date=c.statement_issue_date) AS statement_id,
  (SELECT min(h.issue_date) FROM card_statements h WHERE h.account_id=c.id AND h.issue_date>c.statement_issue_date) AS next_issue_date
  FROM card_liabilities c FULL OUTER JOIN accounts a ON a.item_id=c.item_id AND a.plaid_account_id=c.plaid_account_id
  JOIN items i ON i.id=coalesce(c.item_id,a.item_id)
  LEFT JOIN card_display_preferences p ON p.item_id=i.id AND p.plaid_account_id=coalesce(c.plaid_account_id,a.plaid_account_id)
  WHERE (c.id IS NOT NULL OR a.type='credit')`;

export const STATEMENTS_SQL = `SELECT h.*,
  (SELECT min(n.issue_date) FROM card_statements n WHERE n.account_id=h.account_id AND n.issue_date>h.issue_date) AS next_issue_date
  FROM card_statements h`;

export function statementStale(card: BillCard, bank: BillBank | undefined, now = Date.now()): boolean {
  return !card.available || bank?.status !== "ready" || !card.observed_at ||
    !Number.isFinite(Date.parse(card.observed_at)) || now - Date.parse(card.observed_at) > STATEMENT_STALE_HOURS * 3.6e6;
}

function historyVerificationReason(bank: BillBank): string | null {
  if (bank.history_verification_status === "active")
    return "Payment history is being rechecked. Finish verification before estimating this statement.";
  if (bank.history_verification_status !== "failed") return null;
  switch (bank.history_verification_code) {
    case "SOURCE_UPDATE_FAILED":
      return "The last history check found that Plaid's bank update failed. A successful update and another history check are needed.";
    case "SOURCE_MARKER_STALE":
      return "The last history check found that Plaid's bank data was more than 30 hours old. Updated data and another history check are needed.";
    case "SOURCE_MARKER_MISSING":
      return "Plaid did not provide its last successful bank-update time, so payment history could not be verified.";
    case "SOURCE_ITEM_STATUS_MISSING":
      return "Plaid did not provide this connection's status, so payment history could not be verified.";
    case "SOURCE_MARKER_INVALID":
    case "SOURCE_MARKER_FUTURE":
    case "SOURCE_FAILURE_MARKER_INVALID":
      return "Plaid's bank-update timing could not be verified. Another history check is needed before estimating this statement.";
    case "HISTORY_ACCOUNTS_CHANGED":
    case "HISTORY_ACCOUNT_OWNER_CHANGED":
    case "HISTORY_SAVED_CREDIT_ACCOUNT_MISSING":
    case "HISTORY_SOURCE_ACCOUNT_INVALID":
    case "HISTORY_SOURCE_ACCOUNT_UNKNOWN":
      return "Saved accounts and Plaid's reported accounts did not match during the last history check. Resolve the account mismatch, then verify payment history again.";
    case "SOURCE_ITEM_ERROR":
    case "HISTORY_ITEM_ERROR":
      return "The last history check found a Plaid connection problem. Resolve it, then verify payment history again.";
    default:
      return "The last history verification did not finish successfully. Verify payment history again before estimating this statement.";
  }
}

export function paymentCoverage(card: BillCard, bank: BillBank | undefined, issueDate: string | null): PaymentCoverage {
  const reasons: string[] = [];
  if (card.transaction_account_id === null) reasons.push("This card has no transaction feed.");
  if (!bank?.synced_once || bank.transactions_update_status !== "HISTORICAL_UPDATE_COMPLETE") reasons.push("Plaid has not confirmed that transaction history is ready.");
  if (bank?.downloading) reasons.push("Transaction history is downloading.");
  if (!bank || !["ok", "expiring"].includes(bank.health.state)) reasons.push(bank?.health.message || "The transaction connection is unavailable.");
  // A deliberate reconciliation proves agreement with all records currently available
  // from Plaid for its interval. It must overlap the normal ongoing sync boundary.
  // Keep that provenance separate from the original requested-history boundary.
  const historical = !!issueDate && !!bank?.transactions_history_start_date && bank.transactions_history_start_date <= issueDate;
  const verificationReason = bank ? historyVerificationReason(bank) : null;
  const verified = !!issueDate && !!bank?.transactions_history_start_date && !!bank.transactions_verified_start_date
    && !!bank.transactions_verified_end_date && !!bank.transactions_verified_at
    && !verificationReason
    && bank.transactions_verified_start_date <= issueDate && bank.transactions_verified_end_date >= bank.transactions_history_start_date;
  if (!historical && !verified) reasons.push(verificationReason || "Available transaction history does not cover this statement's full payment window.");
  if (statementStale(card, bank)) reasons.push("Statement details need an update.");
  return { complete: reasons.length === 0, reasons, ...(!historical && verified ? {source:"plaid_available_history" as const} : {}) };
}

/** Indexed account/date range, bounded even for an unusually long gap between statements.
 * Read both signs so an identified returned payment can invalidate an earlier payment. */
export async function paymentWindow(env: Env, card: BillCard, from: string | null, to: string | null) {
  if (!card.transaction_account_id || !from) return { transactions: [] as PaymentTransaction[], truncated: false };
  const { results } = await env.DB.prepare(`SELECT id, amount_cents, currency, date, name, merchant_name,
    category, category_detailed, category_confidence, pending FROM transactions
    WHERE account_id=?1 AND date>?2 AND date<=?3 AND pending=0
    AND (amount_cents<0 OR upper(coalesce(name,'') || ' ' || coalesce(merchant_name,'')) LIKE '%PAY%')
    ORDER BY date DESC,id DESC LIMIT ?4`)
    .bind(card.transaction_account_id, from, to || new Date().toISOString().slice(0, 10), MAX_WINDOW_TRANSACTIONS + 1).all<PaymentTransaction>();
  return { transactions: results.slice(0, MAX_WINDOW_TRANSACTIONS), truncated: results.length > MAX_WINDOW_TRANSACTIONS };
}

export function boundedCoverage(coverage: PaymentCoverage, truncated: boolean): PaymentCoverage {
  return truncated ? { ...coverage, complete: false, reasons: [...coverage.reasons, "The payment window exceeds the transaction review limit; this calculation is incomplete."] } : coverage;
}

export interface CardInputs { window: { transactions: PaymentTransaction[]; truncated: boolean }; dates: string[] }

/** Two bulk indexed reads, regardless of card count, stay within D1 Free's per-request query limit. */
export async function overviewInputs(env: Env, owner: string | null): Promise<Map<number, CardInputs>> {
  const [transactions, dates] = await env.DB.batch([
    env.DB.prepare(`SELECT c.id AS card_id, t.id,t.amount_cents,t.currency,t.date,t.name,t.merchant_name,
      t.category,t.category_detailed,t.category_confidence,t.pending FROM card_liabilities c
      JOIN items i ON i.id=c.item_id CROSS JOIN accounts a ON a.item_id=c.item_id AND a.plaid_account_id=c.plaid_account_id
      CROSS JOIN transactions t INDEXED BY idx_txn_account_date ON t.account_id=a.id AND t.date>c.statement_issue_date AND t.date<=date('now')
      WHERE (?1 IS NULL OR i.owner=?1) AND t.pending=0
      AND (t.amount_cents<0 OR upper(coalesce(t.name,'') || ' ' || coalesce(t.merchant_name,'')) LIKE '%PAY%')
      ORDER BY t.date DESC,t.id DESC LIMIT ?2`).bind(owner, MAX_WINDOW_TRANSACTIONS + 1),
    env.DB.prepare(`SELECT c.id AS account_id,h.issue_date FROM card_liabilities c
      JOIN items i ON i.id=c.item_id LEFT JOIN card_statements h ON h.account_id=c.id
      AND h.issue_date IN (SELECT n.issue_date FROM card_statements n WHERE n.account_id=c.id ORDER BY n.issue_date DESC LIMIT 2)
      WHERE (?1 IS NULL OR i.owner=?1)`)
      .bind(owner),
  ]);
  const inputs = new Map<number, CardInputs>(), truncated = transactions.results.length > MAX_WINDOW_TRANSACTIONS;
  const entry = (id: number) => {
    if (!inputs.has(id)) inputs.set(id, { window: { transactions: [], truncated }, dates: [] });
    return inputs.get(id)!;
  };
  for (const row of dates.results as unknown as { account_id: number; issue_date: string | null }[]) {
    const input = entry(row.account_id);
    if (row.issue_date) input.dates.push(row.issue_date);
  }
  for (const row of transactions.results.slice(0, MAX_WINDOW_TRANSACTIONS) as unknown as (PaymentTransaction & { card_id: number })[]) entry(row.card_id).window.transactions.push(row);
  return inputs;
}

export async function expandCard(env: Env, card: BillCard & { statement_currency?: string | null }, bank: BillBank | undefined, inputs?: CardInputs) {
  const [window, dates] = inputs ? [inputs.window, inputs.dates] : await Promise.all([
    paymentWindow(env, card, card.statement_issue_date, null),
    card.id ? env.DB.prepare("SELECT issue_date FROM card_statements WHERE account_id=? ORDER BY issue_date DESC LIMIT 2").bind(card.id).all<{ issue_date: string }>().then(r => r.results.map(d => d.issue_date)) : Promise.resolve([]),
  ]);
  const coverage = boundedCoverage(paymentCoverage(card, bank, card.statement_issue_date), window.truncated);
  const statementCurrency = card.statement_currency ?? null;
  const chargeCard = isChargeCard(card);
  return { ...card, statement_currency: statementCurrency,
    statement_access: bank?.status !== "disabled", statement_stale: statementStale(card, bank),
    is_charge_card: chargeCard,
    current_utilization: chargeCard ? null : currentUtilization(card.current_balance_cents, card.credit_limit_cents),
    estimated_next_statement_date: forecastStatementDate(dates),
    payment_summary: summarizePayments({ issue_date: card.statement_issue_date, balance_cents: card.statement_balance_cents, currency: statementCurrency },
      card.next_issue_date, window.transactions, coverage, { last_payment_cents: card.last_payment_cents, last_payment_date: card.last_payment_date }),
  };
}
