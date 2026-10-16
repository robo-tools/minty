/** Payment observations on a credit-card feed, never issuer-confirmed statement allocation. */
export interface PaymentTransaction {
  id: number | string;
  plaid_txn_id?: string;
  amount_cents: number;
  currency: string | null;
  date: string;
  name: string;
  merchant_name?: string | null;
  category?: string | null;
  category_detailed?: string | null;
  category_confidence?: string | null;
  pending: number | boolean;
}

export interface PaymentEvidence { evidence: "strong" | "likely"; reason: string }
export interface DetectedPayment extends PaymentTransaction, PaymentEvidence { payment_cents: number }
export interface PaymentCoverage { complete: boolean; reasons: string[]; source?: "plaid_available_history" }
export interface StatementInput { issue_date: string | null; balance_cents: number | null; currency: string | null }
export interface PaymentSummary {
  window_end_date: string;
  statement_balance_cents: number | null;
  detected_payment_cents: number;
  strong_payment_cents: number;
  likely_payment_cents: number;
  payment_count: number;
  strong_count: number;
  likely_count: number;
  remaining_cents: number | null;
  confidence: "strong" | "likely" | "incomplete";
  coverage: PaymentCoverage;
  discrepancy: boolean;
  discrepancy_reason: string | null;
}

const validDate = (value: string | null): value is string => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
};
const text = (t: PaymentTransaction) => `${t.name ?? ""} ${t.merchant_name ?? ""}`.toUpperCase().replace(/[_-]/g, " ");
const exclusion = /\b(?:REFUND\w*|REWARD\w*|CASH\s*BACK|REVERS\w*|RETURN(?:ED)?|CHARGEBACK|CREDIT ADJUSTMENT)\b/;
const paymentDescription = /\b(?:PAYMENT\s+(?:RECEIVED|THANK\s*YOU|THANKYOU)|(?:CREDIT\s*CARD|ONLINE|ELECTRONIC|AUTOMATIC|AUTO\s*PAY|ACH|MOBILE|BILL)\s+PAYMENT|AUTOPAY)\b/;
const expenseCategory = /^(?:BANK_FEES|ENTERTAINMENT|FOOD_AND_DRINK|GENERAL_MERCHANDISE|GENERAL_SERVICES|GOVERNMENT_AND_NON_PROFIT|HOME_IMPROVEMENT|MEDICAL|PERSONAL_CARE|RENT_AND_UTILITIES|TRANSPORTATION|TRAVEL)(?:_|$)/;
const paymentReversal = (t: PaymentTransaction) => !t.pending && Number.isSafeInteger(t.amount_cents) && t.amount_cents > 0 &&
  /(?:\b(?:PAYMENT|AUTO\s*PAY)\b.*\b(?:RETURN\w*|REVERS\w*)\b|\b(?:RETURN\w*|REVERS\w*)\b.*\b(?:PAYMENT|AUTO\s*PAY)\b)/.test(text(t));

/** Plaid uses negative amounts for money credited to a card. Positive checking debits never qualify. */
export function classifyPayment(t: PaymentTransaction): PaymentEvidence | null {
  if (t.pending || !Number.isSafeInteger(t.amount_cents) || t.amount_cents >= 0 || !validDate(t.date)) return null;
  return paymentEvidence(t);
}

/** Called only after the posted sign, integer amount, and date checks. */
function paymentEvidence(t: PaymentTransaction): PaymentEvidence | null {
  const description = text(t), category = `${t.category ?? ""} ${t.category_detailed ?? ""}`.toUpperCase();
  if (exclusion.test(description) || /REFUND|REWARD|CASH_BACK|REVERSAL|CHARGEBACK/.test(category)) return null;
  const explicit = /(?:^|\s)(?:LOAN_PAYMENTS_CREDIT_CARD_PAYMENT|CREDIT_CARD_PAYMENT|PAYMENT_CREDIT_CARD)(?:$|\s)/.test(category);
  if (explicit) {
    const confidence = t.category_confidence?.toUpperCase();
    const uncertain = confidence && !["HIGH", "VERY_HIGH"].includes(confidence);
    return uncertain
      ? { evidence: "likely", reason: `Plaid classifies this as a credit-card payment (${confidence.toLowerCase()} confidence).` }
      : { evidence: "strong", reason: "Plaid classifies this as a credit-card payment." };
  }
  if (expenseCategory.test(t.category?.toUpperCase() ?? "") || expenseCategory.test(t.category_detailed?.toUpperCase() ?? "")) return null;
  return paymentDescription.test(description)
    ? { evidence: "likely", reason: "The description suggests a card payment." }
    : null;
}

function observations(statement: StatementInput, nextIssueDate: string | null, transactions: PaymentTransaction[], asOf: string) {
  const end = validDate(nextIssueDate) && nextIssueDate < asOf ? nextIssueDate : asOf;
  if (!validDate(statement.issue_date)) return { payments: [] as DetectedPayment[], reversal: false, unmatchedCurrency: false, end };
  const unique = new Map<string, PaymentTransaction>();
  // Modified records replace earlier versions if a caller has combined pages. Plaid IDs win over local IDs.
  for (const t of transactions) unique.set(t.plaid_txn_id ? `plaid:${t.plaid_txn_id}` : `local:${t.id}`, t);
  const candidates: DetectedPayment[] = [];
  const reversals: PaymentTransaction[] = [], dates = new Map<string, boolean>();
  const dateValid = (value: string) => {
    if (!dates.has(value)) dates.set(value, validDate(value));
    return dates.get(value)!;
  };
  let unmatchedCurrency = false, reversal = false;
  for (const t of unique.values()) {
    if (t.pending || !Number.isSafeInteger(t.amount_cents) || t.date <= statement.issue_date || t.date > asOf) continue;
    if (t.amount_cents > 0) {
      // Later returns can undo an earlier statement's payment. Ordinary purchases never matter.
      if (paymentReversal(t) && dateValid(t.date)) reversals.push(t);
      continue;
    }
    if (t.amount_cents === 0 || t.date > end || !dateValid(t.date)) continue;
    const evidence = paymentEvidence(t);
    if (!evidence) continue;
    if (!statement.currency || t.currency !== statement.currency) { unmatchedCurrency = true; continue; }
    candidates.push({ ...t, ...evidence, payment_cents: -t.amount_cents });
  }
  const chronological = (a: PaymentTransaction, b: PaymentTransaction) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id));
  candidates.sort(chronological);
  reversals.sort(chronological);
  for (const t of reversals) {
    // An exact amount/date ordering is only a probable pair. Coverage is withheld until reviewed.
    const index = candidates.findLastIndex(p => p.date <= t.date && p.payment_cents === t.amount_cents && p.currency === t.currency);
    if (index >= 0) { candidates.splice(index, 1); reversal = true; }
    // An unmatched later return must not invalidate unrelated historical windows. Within the
    // window, even an unmatched return warrants review because its original payment is unknown.
    else if (t.date <= end) reversal = true;
  }
  return { payments: candidates, reversal, unmatchedCurrency, end };
}

/** Each payment belongs to one window: issue < posted <= next issue. Callers also pass later
 * transactions through asOf so a returned payment cannot leave an older estimate covered. */
export function detectedPayments(statement: StatementInput, nextIssueDate: string | null, transactions: PaymentTransaction[], asOf = new Date().toISOString().slice(0, 10)): DetectedPayment[] {
  return observations(statement, nextIssueDate, transactions, asOf).payments;
}

export function summarizePayments(
  statement: StatementInput, nextIssueDate: string | null, transactions: PaymentTransaction[], coverage: PaymentCoverage,
  options: { asOf?: string; last_payment_cents?: number | null; last_payment_date?: string | null } = {},
): PaymentSummary {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const observed = observations(statement, nextIssueDate, transactions, asOf), reasons = [...coverage.reasons];
  if (!coverage.complete && !reasons.length) reasons.push("Transaction history is incomplete.");
  if (!validDate(statement.issue_date)) reasons.push("The statement issue date is missing.");
  if (statement.balance_cents === null || !Number.isSafeInteger(statement.balance_cents)) reasons.push("The statement balance is unavailable.");
  if (!statement.currency) reasons.push("The statement currency is unavailable.");
  if (observed.unmatchedCurrency) reasons.push("A possible payment has a different or unknown currency.");
  if (observed.reversal) reasons.push("A returned or reversed payment needs review.");
  const strong = observed.payments.filter(t => t.evidence === "strong"), likely = observed.payments.filter(t => t.evidence === "likely");
  const sum = (rows: DetectedPayment[]) => rows.reduce((total, t) => total + t.payment_cents, 0);
  const total = sum(observed.payments);
  if (!Number.isSafeInteger(total)) reasons.push("The payment total is outside the supported range.");
  const complete = coverage.complete && reasons.length === 0;
  const lastDate = options.last_payment_date, lastAmount = options.last_payment_cents;
  const lastInWindow = validDate(lastDate ?? null) && validDate(statement.issue_date) && lastDate! > statement.issue_date && lastDate! <= observed.end;
  const discrepancy = !!(lastInWindow && typeof lastAmount === "number" && lastAmount > 0 &&
    !observed.payments.some(t => t.date === lastDate && t.payment_cents === lastAmount));
  return {
    window_end_date: observed.end,
    statement_balance_cents: statement.balance_cents,
    detected_payment_cents: total, strong_payment_cents: sum(strong), likely_payment_cents: sum(likely),
    payment_count: observed.payments.length, strong_count: strong.length, likely_count: likely.length,
    remaining_cents: complete ? Math.max(statement.balance_cents! - total, 0) : null,
    confidence: !complete ? "incomplete" : likely.length || discrepancy ? "likely" : "strong",
    coverage: { ...coverage, complete, reasons: [...new Set(reasons)] }, discrepancy,
    discrepancy_reason: discrepancy ? "The bank's last reported payment does not match the payments observed in this statement window. It has not been subtracted again." : null,
  };
}

/** The next issue date is only a calendar estimate; callers never attach a predicted balance. */
export function forecastStatementDate(issueDates: string[]): string | null {
  const dates = [...new Set(issueDates.filter(validDate))].sort().reverse();
  if (!dates.length) return null;
  const parts = (value: string) => value.split("-").map(Number);
  const monthDays = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const isEnd = (value: string) => { const [year, month, day] = parts(value); return day === monthDays(year, month); };
  const [year, month, day] = parts(dates[0]);
  const nextYear = month === 12 ? year + 1 : year, nextMonth = month === 12 ? 1 : month + 1;
  const lastDay = monthDays(nextYear, nextMonth);
  const nextDay = dates.length >= 2 && isEnd(dates[0]) && isEnd(dates[1]) ? lastDay : Math.min(day, lastDay);
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}`;
}

/** Current account utilization, not the balance or utilization reported to a credit bureau. */
export function currentUtilization(balance: number | null, limit: number | null): number | null {
  if (balance === null || limit === null || !Number.isFinite(balance) || !Number.isFinite(limit) || limit <= 0) return null;
  return Math.max(balance, 0) / limit * 100;
}
