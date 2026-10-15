import { describe, expect, it } from "vitest";
import { classifyPayment, currentUtilization, detectedPayments, forecastStatementDate, summarizePayments,
  type PaymentTransaction, type StatementInput } from "../src/statement-payments";

const statement: StatementInput = { issue_date: "2026-09-20", balance_cents: 100_000, currency: "USD" };
const complete = { complete: true, reasons: [] };
const transaction = (changes: Partial<PaymentTransaction> = {}): PaymentTransaction => ({
  id: 1, plaid_txn_id: "card-payment-1", amount_cents: -20_000, currency: "USD", date: "2026-10-01", name: "Payment received",
  merchant_name: null, category: "LOAN_PAYMENTS", category_detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
  category_confidence: "VERY_HIGH", pending: 0, ...changes,
});
const summary = (transactions: PaymentTransaction[], changes: Partial<StatementInput> = {}) =>
  summarizePayments({ ...statement, ...changes }, null, transactions, complete, { asOf: "2026-10-15" });

describe("card payment evidence", () => {
  it("uses the explicit credit-card classification as stronger evidence", () => {
    expect(classifyPayment(transaction({ name: "Bank transfer" }))).toEqual({
      evidence: "strong", reason: "Plaid classifies this as a credit-card payment.",
    });
    expect(classifyPayment(transaction({ category_confidence: null }))?.evidence).toBe("strong");
  });
  it.each(["LOW", "MEDIUM", "UNKNOWN"])("keeps %s category confidence visibly uncertain", confidence => {
    expect(classifyPayment(transaction({ category_confidence: confidence }))?.evidence).toBe("likely");
  });
  it.each(["AUTOPAY", "Automatic payment", "Payment Thank You", "PAYMENT RECEIVED", "Online payment", "ACH PAYMENT", "Credit Card Payment"])(
    "includes the clear description %s as a likely match", name => {
      expect(classifyPayment(transaction({ name, category: "TRANSFER_IN", category_detailed: null }))?.evidence).toBe("likely");
    });
  it("does not call every transfer or generic loan credit a card payment", () => {
    for (const name of ["Transfer", "ACH CREDIT", "Payment", "ATM deposit", "Loan proceeds"])
      expect(classifyPayment(transaction({ name, category: "TRANSFER_IN", category_detailed: "TRANSFER_IN_ACCOUNT_TRANSFER" }))).toBeNull();
    expect(classifyPayment(transaction({ name: "Loan", category_detailed: "LOAN_PAYMENTS_OTHER_PAYMENT" }))).toBeNull();
  });
  it("excludes pending transactions and positive checking-side debits", () => {
    expect(classifyPayment(transaction({ pending: 1 }))).toBeNull();
    expect(classifyPayment(transaction({ amount_cents: 20_000 }))).toBeNull();
    expect(classifyPayment(transaction({ amount_cents: 0 }))).toBeNull();
  });
  it.each(["Payment refund", "Autopay reward", "Cashback payment", "Payment reversal", "Returned payment", "Chargeback credit", "Credit adjustment"])(
    "excludes %s even with an explicit payment category", name => expect(classifyPayment(transaction({ name }))).toBeNull());
  it("excludes reward classifications and credits in purchase categories", () => {
    expect(classifyPayment(transaction({ category_detailed: "INCOME_OTHER_INCOME_REWARD" }))).toBeNull();
    expect(classifyPayment(transaction({ category: "FOOD_AND_DRINK", category_detailed: "FOOD_AND_DRINK_RESTAURANTS" }))).toBeNull();
  });
  it("rejects impossible dates and invalid amounts", () => {
    expect(classifyPayment(transaction({ date: "2026-02-30" }))).toBeNull();
    expect(classifyPayment(transaction({ amount_cents: -2.3 }))).toBeNull();
    expect(classifyPayment(transaction({ amount_cents: -Infinity }))).toBeNull();
  });
});

describe("statement payment observations", () => {
  it("includes likely payments automatically and shows the full calculation", () => {
    const result = summary([transaction(), transaction({ id: 2, plaid_txn_id: "likely", amount_cents: -15_000, category_detailed: null, category: "TRANSFER_IN" })]);
    expect(result).toMatchObject({ statement_balance_cents: 100_000, detected_payment_cents: 35_000, remaining_cents: 65_000,
      strong_payment_cents: 20_000, likely_payment_cents: 15_000, payment_count: 2, strong_count: 1, likely_count: 1,
      confidence: "likely", coverage: complete, window_end_date: "2026-10-15" });
  });
  it.each([0, 40_000, 100_000, 130_000])("clamps remaining statement amounts for a %i-cent payment", amount => {
    expect(summary(amount ? [transaction({ amount_cents: -amount })] : []).remaining_cents).toBe(Math.max(100_000 - amount, 0));
  });
  it("clamps zero and credit statement balances to zero", () => {
    expect(summary([], { balance_cents: 0 }).remaining_cents).toBe(0);
    expect(summary([], { balance_cents: -500 }).remaining_cents).toBe(0);
  });
  it("counts duplicate card feeds once without conflating distinct transactions of the same amount", () => {
    expect(summary([transaction(), transaction({ id: 88 }), transaction({ id: 2, plaid_txn_id: "separate" })])).toMatchObject({
      detected_payment_cents: 40_000, payment_count: 2,
    });
  });
  it("recomputes modified and removed payments, replacing older duplicate versions", () => {
    expect(summary([transaction(), transaction({ amount_cents: -30_000 })]).remaining_cents).toBe(70_000);
    expect(summary([transaction({ amount_cents: -30_000 })]).remaining_cents).toBe(70_000);
    expect(summary([]).remaining_cents).toBe(100_000);
    expect(summary([transaction(), transaction({ name: "Merchant refund" })]).remaining_cents).toBe(100_000);
  });
  it("counts only posted data during a pending-to-posted transition", () => {
    expect(summary([transaction({ plaid_txn_id: "pending", pending: 1 }), transaction({ plaid_txn_id: "posted", id: 2 })])).toMatchObject({
      payment_count: 1, detected_payment_cents: 20_000,
    });
  });
  it("assigns same-day statement boundaries to the earlier statement exactly once", () => {
    const rows = [transaction({ date: "2026-09-20", plaid_txn_id: "issue" }),
      transaction({ date: "2026-10-20", plaid_txn_id: "boundary", id: 2 }),
      transaction({ date: "2026-10-21", plaid_txn_id: "later", id: 3 })];
    expect(detectedPayments(statement, "2026-10-20", rows, "2026-10-30").map(t => t.plaid_txn_id)).toEqual(["boundary"]);
    expect(detectedPayments({ ...statement, issue_date: "2026-10-20" }, null, rows, "2026-10-30").map(t => t.plaid_txn_id)).toEqual(["later"]);
  });
  it("never includes future transaction dates", () => {
    expect(summary([transaction({ date: "2026-10-16" })]).payment_count).toBe(0);
  });
  it.each(["Transaction history is downloading.", "Bank sync is stale.", "Transaction history is unavailable."])(
    "withholds estimates when %s", reason => {
      expect(summarizePayments(statement, null, [transaction()], { complete: false, reasons: [reason] }, { asOf: "2026-10-15" }))
        .toMatchObject({ statement_balance_cents: 100_000, detected_payment_cents: 20_000, remaining_cents: null,
          confidence: "incomplete", coverage: { complete: false, reasons: [reason] } });
    });
  it("requires a statement date, balance and currency", () => {
    for (const change of [{ issue_date: null }, { balance_cents: null }, { currency: null }])
      expect(summary([transaction()], change)).toMatchObject({ remaining_cents: null, coverage: { complete: false } });
  });
  it("does not subtract another currency or an unidentified currency", () => {
    for (const currency of [null, "EUR"])
      expect(summary([transaction({ currency })])).toMatchObject({ detected_payment_cents: 0, remaining_cents: null,
        coverage: { complete: false, reasons: ["A possible payment has a different or unknown currency."] } });
  });
  it("keeps the reported last payment as support instead of subtracting it twice", () => {
    const result = summarizePayments(statement, null, [transaction()], complete, {
      asOf: "2026-10-15", last_payment_date: "2026-10-01", last_payment_cents: 20_000,
    });
    expect(result).toMatchObject({ detected_payment_cents: 20_000, remaining_cents: 80_000, discrepancy: false });
  });
  it("flags disagreement with the bank's last payment without inventing a transaction", () => {
    const result = summarizePayments(statement, null, [transaction()], complete, {
      asOf: "2026-10-15", last_payment_date: "2026-10-02", last_payment_cents: 20_000,
    });
    expect(result).toMatchObject({ detected_payment_cents: 20_000, remaining_cents: 80_000, discrepancy: true, confidence: "likely" });
    expect(summarizePayments(statement, null, [], complete, { asOf: "2026-10-15", last_payment_date: "2026-09-19", last_payment_cents: 20_000 }).discrepancy).toBe(false);
  });
  it("excludes a probable reversed payment and withholds the estimate for review", () => {
    const reversal = transaction({ id: 2, plaid_txn_id: "reversal", name: "Returned payment", amount_cents: 20_000, date: "2026-10-03" });
    expect(summary([transaction(), reversal])).toMatchObject({ payment_count: 0, detected_payment_cents: 0, remaining_cents: null,
      coverage: { complete: false, reasons: ["A returned or reversed payment needs review."] } });
  });
  it("handles same-day and unmatched payment reversals conservatively", () => {
    const reversal = transaction({ id: 0, plaid_txn_id: "reverse", name: "Payment reversal", amount_cents: 20_000 });
    expect(summary([reversal, transaction()])).toMatchObject({ payment_count: 0, remaining_cents: null });
    expect(summary([reversal])).toMatchObject({ payment_count: 0, remaining_cents: null });
  });
  it("withholds historical coverage when a matching payment is returned after the next statement", () => {
    const paid = transaction({ amount_cents: -100_000, date: "2026-10-19" });
    const returned = transaction({ id: 2, plaid_txn_id: "returned-later", name: "Payment returned", amount_cents: 100_000, date: "2026-10-22" });
    const rows = [returned, paid];
    expect(summarizePayments(statement, "2026-10-20", rows, complete, { asOf: "2026-10-30" })).toMatchObject({
      payment_count: 0, detected_payment_cents: 0, remaining_cents: null, window_end_date: "2026-10-20",
      coverage: { complete: false, reasons: ["A returned or reversed payment needs review."] },
    });
    expect(detectedPayments(statement, "2026-10-20", rows, "2026-10-30")).toEqual([]);
  });
  it.each(["AUTOPAY REVERSAL", "RETURNED AUTO PAY", "Reversal of ACH payment"])("recognizes the returned-payment description %s", name => {
    const returned = transaction({ id: 2, plaid_txn_id: "return", name, amount_cents: 20_000, date: "2026-10-22" });
    expect(summarizePayments(statement, "2026-10-20", [transaction(), returned], complete, { asOf: "2026-10-30" }))
      .toMatchObject({ detected_payment_cents: 0, remaining_cents: null });
  });
  it("does not invalidate unrelated history for a later return with a different amount or currency", () => {
    for (const change of [{ amount_cents: 15_000 }, { currency: "EUR" }]) {
      const returned = transaction({ id: 2, plaid_txn_id: "unrelated-return", name: "Payment returned", amount_cents: 20_000, date: "2026-10-22", ...change });
      expect(summarizePayments(statement, "2026-10-20", [transaction(), returned], complete, { asOf: "2026-10-30" })).toMatchObject({
        payment_count: 1, detected_payment_cents: 20_000, remaining_cents: 80_000, coverage: complete,
      });
    }
  });
  it("ignores pending, future, and invalid later returns", () => {
    for (const change of [{ pending: 1 }, { date: "2026-11-01" }, { date: "2026-10-32" }, { amount_cents: 20_000.1 }]) {
      const returned = transaction({ id: 2, plaid_txn_id: "unposted-return", name: "Payment reversal", amount_cents: 20_000, date: "2026-10-22", ...change });
      expect(summarizePayments(statement, "2026-10-20", [transaction(), returned], complete, { asOf: "2026-10-30" })).toMatchObject({
        remaining_cents: 80_000, coverage: complete,
      });
    }
  });
  it("does not add later payments to the older statement while reviewing a later reversal", () => {
    const nextPayment = transaction({ id: 3, plaid_txn_id: "next-payment", amount_cents: -30_000, date: "2026-10-21" });
    const returned = transaction({ id: 2, plaid_txn_id: "return", name: "Returned payment", amount_cents: 20_000, date: "2026-10-22" });
    expect(summarizePayments(statement, "2026-10-20", [transaction(), nextPayment, returned], complete, { asOf: "2026-10-30" }))
      .toMatchObject({ payment_count: 0, detected_payment_cents: 0, remaining_cents: null });
  });
  it("recomputes historical reversal handling after a correction or removal", () => {
    const returned = transaction({ id: 2, plaid_txn_id: "return", name: "Returned payment", amount_cents: 20_000, date: "2026-10-22" });
    const estimate = (rows: PaymentTransaction[]) => summarizePayments(statement, "2026-10-20", rows, complete, { asOf: "2026-10-30" });
    expect(estimate([transaction(), returned]).remaining_cents).toBeNull();
    expect(estimate([transaction(), returned, { ...returned, name: "Grocery purchase" }])).toMatchObject({ remaining_cents: 80_000, coverage: complete });
    expect(estimate([transaction()])).toMatchObject({ remaining_cents: 80_000, coverage: complete });
  });
});

describe("statement date estimates and current utilization", () => {
  it.each([
    [["2026-01-31"], "2026-02-28"], [["2024-01-31"], "2024-02-29"], [["2026-12-20"], "2027-01-20"],
    [["2026-02-28"], "2026-03-28"], [["2026-01-31", "2026-02-28"], "2026-03-31"],
    [["2024-01-31", "2024-02-29"], "2024-03-31"], [["2026-01-30", "2026-02-28"], "2026-03-28"],
    [["2026-03-31", "2026-04-30"], "2026-05-31"],
  ])("predicts one month after %j as %s", (dates, expected) => expect(forecastStatementDate(dates)).toBe(expected));
  it("replaces a forecast with the newly reported statement before predicting again", () => {
    expect(forecastStatementDate(["2026-09-20"])).toBe("2026-10-20");
    expect(forecastStatementDate(["2026-09-20", "2026-10-22"])).toBe("2026-11-22");
  });
  it("does not establish a month-end pattern from duplicate dates or invalid history", () => {
    expect(forecastStatementDate(["2026-02-28", "2026-02-28", "2026-02-30"])).toBe("2026-03-28");
    expect(forecastStatementDate([])).toBeNull();
    expect(forecastStatementDate(["not-a-date"])).toBeNull();
  });
  it.each([[null, 100_000, null], [30_000, null, null], [30_000, 0, null], [30_000, -1, null],
    [-500, 100_000, 0], [0, 100_000, 0], [25_000, 100_000, 25], [120_000, 100_000, 120]])(
    "computes current utilization for balance %s and limit %s", (balance, limit, expected) => expect(currentUtilization(balance, limit)).toBe(expected));
});
