import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { saveLiabilities } from "../src/liabilities";
import { call, getJson, loadFixture } from "./helpers";

const E = env as unknown as Env;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const statementPayload = (issue = "2026-09-01", balance = 1000, limit: number | null = 2000) => ({
  accounts: [{ account_id: "acct-10", name: "Sapphire", mask: "9912", type: "credit", subtype: "credit card",
    balances: { current: 1200, limit, iso_currency_code: "USD" } }],
  liabilities: { credit: [{ account_id: "acct-10", last_statement_issue_date: issue, last_statement_balance: balance,
    minimum_payment_amount: 25, next_payment_due_date: "2026-09-25", last_payment_amount: null,
    last_payment_date: null, is_overdue: false }] },
});
async function enable(issue = "2026-09-01", balance = 1000) {
  await E.DB.prepare(`INSERT INTO liability_sync(item_id,status,enabled_at,synced_at) VALUES(1,'ready',${NOW},${NOW})`).run();
  await saveLiabilities(E, 1, statementPayload(issue, balance));
  const card = (await E.DB.prepare("SELECT id FROM card_liabilities WHERE item_id=1").first<{ id: number }>())!;
  const statement = (await E.DB.prepare("SELECT id FROM card_statements WHERE account_id=? AND issue_date=?")
    .bind(card.id, issue).first<{ id: number }>())!;
  return { cardId: card.id, statementId: statement.id };
}
async function payment(id: number, opts: { account?: number; cents?: number; date?: string; currency?: string | null;
  pending?: number; name?: string; detailed?: string | null; confidence?: string | null } = {}) {
  await E.DB.prepare(`INSERT INTO transactions(id,owner,account_id,plaid_txn_id,amount_cents,currency,date,name,
    category,category_detailed,category_confidence,pending) VALUES(?1,'me',?2,?3,?4,?5,?6,?7,'LOAN_PAYMENTS',?8,?9,?10)`)
    .bind(id, opts.account ?? 10, `sensitive-payment-${id}`, opts.cents ?? -20000,
      opts.currency === undefined ? "USD" : opts.currency, opts.date ?? "2026-09-10", opts.name ?? "Payment received",
      opts.detailed === undefined ? "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" : opts.detailed,
      opts.confidence === undefined ? "VERY_HIGH" : opts.confidence, opts.pending ?? 0).run();
}
const overview = async (query = "", overrides: Partial<Env> = {}) => (await getJson(`/liabilities${query}`, { envOverrides: overrides })).body;
const cardOverview = async () => (await overview()).cards.find((c: any) => c.transaction_account_id === 10);
const history = async (id: number) => (await getJson(`/liabilities/history?account_id=${id}`)).body;

beforeEach(async () => {
  await loadFixture();
  await E.DB.prepare("DELETE FROM app_state WHERE key LIKE 'rows_read:%'").run();
  await E.DB.prepare(`UPDATE items SET status='good',txn_cursor='complete',sync_start_cursor=NULL,updated_at=${NOW},
    transactions_update_status='HISTORICAL_UPDATE_COMPLETE',transactions_history_start_date='2025-01-01'`).run();
});

describe("Bills overview account and statement sources", () => {
  it("includes linked credit cards without Liabilities and excludes ordinary checking and savings accounts", async () => {
    await E.DB.prepare("UPDATE accounts SET credit_limit_cents=200000 WHERE id=10").run();
    const result = await overview();
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({ id: null, transaction_account_id: 10, name: "Sapphire",
      current_balance_cents: 128455, credit_limit_cents: 200000, current_utilization: 64.2275,
      statement_access: false, statement_id: null, statement_balance_cents: null, estimated_next_statement_date: null });
    expect(result.cards[0].payment_summary).toMatchObject({ remaining_cents: null, confidence: "incomplete" });
    expect(result.banks.find((b: any) => b.id === 1)).toMatchObject({ status: "disabled", health: { state: "ok" },
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", transactions_history_start_date: "2025-01-01" });
  });

  it("uses the newest reported balance/limit together and keeps statement currency separate", async () => {
    await enable();
    await E.DB.prepare(`UPDATE accounts SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'),
      balance_current_cents=5000,credit_limit_cents=10000,currency='CAD' WHERE id=10`).run();
    expect(await cardOverview()).toMatchObject({ current_balance_cents: 120000, credit_limit_cents: 200000,
      current_utilization: 60, currency: "USD", statement_currency: "USD" });
    await E.DB.prepare(`UPDATE accounts SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 minute'),
      balance_current_cents=150000,credit_limit_cents=100000,currency='CAD' WHERE id=10`).run();
    expect(await cardOverview()).toMatchObject({ current_balance_cents: 150000, credit_limit_cents: 100000,
      current_utilization: 150, currency: "CAD", statement_currency: "USD" });
    await E.DB.prepare("UPDATE accounts SET balance_current_cents=-1000 WHERE id=10").run();
    expect((await cardOverview()).current_utilization).toBe(0);
    for (const limit of [0, null]) {
      await E.DB.prepare("UPDATE accounts SET credit_limit_cents=? WHERE id=10").bind(limit).run();
      expect((await cardOverview()).current_utilization).toBeNull();
    }
  });

  it("replaces forecasts when a real statement arrives and establishes month-end patterns from history", async () => {
    const { cardId } = await enable("2026-01-31");
    expect((await cardOverview()).estimated_next_statement_date).toBe("2026-02-28");
    await saveLiabilities(E, 1, statementPayload("2026-02-28", 900));
    const result = await cardOverview();
    expect(result).toMatchObject({ statement_issue_date: "2026-02-28", statement_balance_cents: 90000,
      estimated_next_statement_date: "2026-03-31", statement_count: 2 });
    expect((await history(cardId)).statements.map((s: any) => s.issue_date)).toEqual(["2026-02-28", "2026-01-31"]);
    expect(result).not.toHaveProperty("estimated_next_statement_balance_cents");
  });
});

describe("Bills payment summaries", () => {
  it("includes strong and likely card payments without double subtracting checking or last-payment fields", async () => {
    const { statementId } = await enable();
    await payment(300);
    await payment(301, { cents: -10000, detailed: null, name: "AUTOPAY PAYMENT" });
    await payment(302, { account: 11, cents: 20000 });
    await E.DB.prepare("UPDATE card_liabilities SET last_payment_cents=20000,last_payment_date='2026-09-10'").run();
    const summary = (await cardOverview()).payment_summary;
    expect(summary).toMatchObject({ statement_balance_cents: 100000, detected_payment_cents: 30000,
      strong_payment_cents: 20000, likely_payment_cents: 10000, remaining_cents: 70000, payment_count: 2,
      confidence: "likely", coverage: { complete: true, reasons: [] }, discrepancy: false });
    const detail = (await getJson(`/liabilities/payments?statement_id=${statementId}`)).body;
    expect(detail.payments.map((p: any) => p.id)).toEqual([301, 300]);
    expect(detail.payments.map((p: any) => p.evidence)).toEqual(["likely", "strong"]);
    await E.DB.prepare("UPDATE card_liabilities SET last_payment_cents=35000,last_payment_date='2026-09-11'").run();
    expect((await cardOverview()).payment_summary).toMatchObject({ discrepancy: true, detected_payment_cents: 30000, remaining_cents: 70000 });
  });

  it("withholds estimates until history and both sync sources are complete and fresh", async () => {
    const { cardId } = await enable();
    await payment(300);
    const cases = [
      ["UPDATE items SET transactions_update_status='INITIAL_UPDATE_COMPLETE' WHERE id=1", /not confirmed/],
      ["UPDATE items SET sync_start_cursor='partial' WHERE id=1", /downloading/],
      ["UPDATE items SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=1", /hasn't synced/],
      ["UPDATE items SET status='login_required' WHERE id=1", /sign in again/],
      ["UPDATE items SET transactions_history_start_date='2026-09-02' WHERE id=1", /full payment window/],
      ["UPDATE items SET transactions_history_start_date=NULL WHERE id=1", /full payment window/],
      ["UPDATE items SET txn_cursor=NULL WHERE id=1", /not confirmed/],
      ["UPDATE card_liabilities SET observed_at='2000-01-01T00:00:00.000Z'", /details need an update/],
    ] as const;
    for (const [sql, reason] of cases) {
      await E.DB.prepare(sql).run();
      const card = await cardOverview();
      expect(card.statement_balance_cents, sql).toBe(100000);
      expect(card.payment_summary, sql).toMatchObject({ remaining_cents: null, confidence: "incomplete", coverage: { complete: false } });
      expect(card.payment_summary.coverage.reasons.join(" "), sql).toMatch(reason);
      expect((await history(cardId)).statements[0].payment_summary.remaining_cents, sql).toBeNull();
      await E.DB.prepare(`UPDATE items SET txn_cursor='complete',sync_start_cursor=NULL,status='good',updated_at=${NOW},
        transactions_update_status='HISTORICAL_UPDATE_COMPLETE',transactions_history_start_date='2025-01-01' WHERE id=1`).run();
      await E.DB.prepare(`UPDATE card_liabilities SET observed_at=${NOW}`).run();
    }
    expect((await cardOverview()).payment_summary.remaining_cents).toBe(80000);
  });

  it("retains statements but withholds payment estimates when the card's transaction feed disappears", async () => {
    const { cardId } = await enable();
    await E.DB.prepare("DELETE FROM accounts WHERE id=10").run();
    const card = (await overview()).cards.find((c: any) => c.id === cardId);
    expect(card).toMatchObject({ transaction_account_id: null, statement_balance_cents: 100000 });
    expect(card.payment_summary.coverage).toMatchObject({ complete: false, reasons: expect.arrayContaining(["This card has no transaction feed."]) });
    expect(card.payment_summary.remaining_cents).toBeNull();
  });

  it("reuses connection configuration and statement availability checks for incomplete coverage", async () => {
    await enable();
    await payment(300);
    const disconnected = await overview("", { PLAID_SECRET_ME_PRIMARY: "" });
    expect(disconnected.banks.find((b: any) => b.id === 1)).toMatchObject({ configured: false, health: { state: "stranded" } });
    expect(disconnected.cards[0].payment_summary).toMatchObject({ remaining_cents: null, coverage: { complete: false } });
    await E.DB.prepare("UPDATE card_liabilities SET available=0 WHERE item_id=1").run();
    expect((await cardOverview()).payment_summary).toMatchObject({ remaining_cents: null, coverage: { complete: false } });
    expect((await cardOverview()).statement_balance_cents).toBe(100000);
  });

  it.each(["CAD", null])("withholds estimates for a possible payment with currency %s", async currency => {
    await enable();
    await payment(300, { currency });
    expect((await cardOverview()).payment_summary).toMatchObject({ detected_payment_cents: 0, remaining_cents: null,
      coverage: { complete: false, reasons: expect.arrayContaining(["A possible payment has a different or unknown currency."]) } });
  });

  it("assigns a payment on the next issue date only to the preceding statement", async () => {
    const { cardId, statementId } = await enable("2026-08-01");
    await saveLiabilities(E, 1, statementPayload("2026-09-01", 800));
    await payment(300, { date: "2026-08-01", cents: -5000 });
    await payment(301, { date: "2026-09-01", cents: -20000 });
    await payment(302, { date: "2026-09-02", cents: -10000 });
    const statements = (await history(cardId)).statements;
    expect(statements[0].payment_summary).toMatchObject({ detected_payment_cents: 10000, remaining_cents: 70000 });
    expect(statements[1].payment_summary).toMatchObject({ detected_payment_cents: 20000, remaining_cents: 80000, window_end_date: "2026-09-01" });
    expect((await getJson(`/liabilities/payments?statement_id=${statementId}`)).body.payments.map((p: any) => p.id)).toEqual([301]);
    expect((await cardOverview()).payment_summary.detected_payment_cents).toBe(10000);
  });

  it("recalculates pending, corrected, removed, refunded and reversed observations on each read", async () => {
    const { statementId } = await enable();
    await payment(300, { pending: 1 });
    expect((await cardOverview()).payment_summary.detected_payment_cents).toBe(0);
    await E.DB.prepare("UPDATE transactions SET pending=0 WHERE id=300").run();
    expect((await cardOverview()).payment_summary.remaining_cents).toBe(80000);
    await E.DB.prepare("UPDATE transactions SET amount_cents=-150000 WHERE id=300").run();
    expect((await cardOverview()).payment_summary.remaining_cents).toBe(0);
    await E.DB.prepare("UPDATE transactions SET name='Refund credit' WHERE id=300").run();
    expect((await cardOverview()).payment_summary.remaining_cents).toBe(100000);
    await E.DB.prepare("UPDATE transactions SET name='Payment received',amount_cents=-20000 WHERE id=300").run();
    await payment(301, { cents: 20000, name: "RETURNED PAYMENT", date: "2026-09-11" });
    expect((await cardOverview()).payment_summary).toMatchObject({ detected_payment_cents: 0, remaining_cents: null, confidence: "incomplete" });
    expect((await getJson(`/liabilities/payments?statement_id=${statementId}`)).body.payments).toEqual([]);
    await E.DB.prepare("DELETE FROM transactions WHERE id IN (300,301)").run();
    expect((await cardOverview()).payment_summary).toMatchObject({ detected_payment_cents: 0, remaining_cents: 100000 });
  });

  it("withdraws a historical covered estimate when a matching payment is returned after the next issue date", async () => {
    const { cardId, statementId } = await enable("2026-08-01", 200);
    await payment(300, { date: "2026-08-20", cents: -20000 });
    await saveLiabilities(E, 1, statementPayload("2026-09-01", 800));
    expect((await history(cardId)).statements[1].payment_summary.remaining_cents).toBe(0);
    await payment(301, { date: "2026-09-02", cents: 20000, name: "PAYMENT REVERSAL" });
    expect((await history(cardId)).statements[1].payment_summary).toMatchObject({ detected_payment_cents: 0, remaining_cents: null, confidence: "incomplete" });
    const detail = (await getJson(`/liabilities/payments?statement_id=${statementId}`)).body;
    expect(detail.payments).toEqual([]);
    expect(detail.payment_summary.remaining_cents).toBeNull();
  });
});

describe("Bills read API boundaries", () => {
  it("paginates detected transactions stably by date and id, after classification", async () => {
    const { statementId } = await enable();
    await E.DB.prepare(`INSERT INTO transactions(id,owner,account_id,plaid_txn_id,amount_cents,currency,date,name,
      category,category_detailed,category_confidence,pending)
      SELECT 1000+value,'me',10,'sensitive-'||value,-100,'USD','2026-09-10','Payment received',
      'LOAN_PAYMENTS','LOAN_PAYMENTS_CREDIT_CARD_PAYMENT','HIGH',0 FROM json_each(?)`)
      .bind(JSON.stringify(Array.from({ length: 55 }, (_, i) => i))).run();
    await payment(1100, { name: "CASHBACK REWARD" });
    const first = (await getJson(`/liabilities/payments?statement_id=${statementId}`)).body;
    expect(first.payments).toHaveLength(50);
    expect(first.next_before).toBe("2026-09-10:1005");
    expect(first.payment_summary).toMatchObject({ payment_count: 55, detected_payment_cents: 5500, remaining_cents: 94500 });
    const second = (await getJson(`/liabilities/payments?statement_id=${statementId}&before=${first.next_before}`)).body;
    expect(second.payments.map((p: any) => p.id)).toEqual([1004, 1003, 1002, 1001, 1000]);
    expect(second.next_before).toBeNull();
    expect(new Set([...first.payments, ...second.payments].map(p => p.id)).size).toBe(55);
    for (const before of ["bad", "2026-02-30:1", "2026-09-10:0", "2026-09-10:9007199254740992"]) {
      expect((await getJson(`/liabilities/payments?statement_id=${statementId}&before=${before}`)).status).toBe(422);
    }
  });

  it("preserves owner filtering, authentication and no-store without exposing Plaid identifiers", async () => {
    const { cardId, statementId } = await enable();
    await payment(300);
    const paths = ["/liabilities", `/liabilities/history?account_id=${cardId}`, `/liabilities/payments?statement_id=${statementId}`];
    for (const path of paths) {
      expect((await call(path, { token: null })).status).toBe(403);
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      for (const secret of ["access_token", "plaid_account", "plaid_txn_id", "acct-10", "sensitive-payment", "gAAAA-not-a-real-token"])
        expect(text, path).not.toContain(secret);
      const separator = path.includes("?") ? "&" : "?";
      expect((await call(`${path}${separator}owner=unknown`)).status).toBe(422);
      const spouse = await getJson(`${path}${separator}owner=spouse`);
      if (path === "/liabilities") {
        expect(spouse.status).toBe(200);
        expect(spouse.body.cards).toEqual([]);
        expect(spouse.body.banks.map((b: any) => b.owner)).toEqual(["spouse"]);
      } else expect(spouse.status).toBe(404);
    }
    expect((await call(`/liabilities/payments?statement_id=${statementId}`, { envOverrides: { ALLOWED_LOGINS: "another@example.com" } })).status).toBe(403);
    for (const id of ["-1", "0", "1.5", "9007199254740992"]) {
      expect((await getJson(`/liabilities/payments?statement_id=${id}`)).status).toBe(422);
    }
    expect((await getJson("/liabilities/payments?statement_id=99999")).status).toBe(404);
  });

  it("keeps all expanded endpoints behind general/search rate limits and the existing read budget", async () => {
    const { cardId, statementId } = await enable();
    const paths = ["/liabilities", `/liabilities/history?account_id=${cardId}`, `/liabilities/payments?statement_id=${statementId}`];
    const refuse = { limit: async () => ({ success: false }) };
    for (const key of ["RL_GENERAL", "RL_SEARCH"] as const) {
      for (const path of paths) {
        const response = await call(path, { envOverrides: { [key]: refuse } as Partial<Env> });
        expect(response.status, `${key} ${path}`).toBe(429);
        expect(response.headers.get("retry-after")).toBe("60");
      }
    }
    await E.DB.prepare("INSERT INTO app_state(key,value) VALUES(?, '101')")
      .bind(`rows_read:${new Date().toISOString().slice(0, 10)}`).run();
    for (const path of paths) {
      const response = await getJson(path, { envOverrides: { READ_BUDGET_PER_DAY: "100" } });
      expect(response.status, path).toBe(429);
      expect(response.body.detail, path).toContain("daily budget");
    }
  });
});
