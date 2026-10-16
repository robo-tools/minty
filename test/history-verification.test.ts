import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { verifyHistoryPage } from "../src/history-verification";
import { FakePlaid, account, plaidError, txn } from "./fake-plaid";

const E = env as unknown as Env, config = loadConfig(E);
let plaid: FakePlaid;
const today = () => new Date().toISOString().slice(0, 10);
const dateAgo = (days: number) => new Date(Date.now() - days * 8.64e7).toISOString().slice(0, 10);
const marker = () => new Date(Date.now() - 60_000).toISOString();
const getItem = () => env.DB.prepare("SELECT * FROM items WHERE id=1").first<any>();
const setItem = async (column: string, value: unknown) => env.DB.prepare(`UPDATE items SET ${column}=? WHERE id=1`).bind(value).run();
const count = async (table: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const run = () => verifyHistoryPage(E, config, 1, "me");

function itemReply(stamp: string | null = marker(), extras: Record<string, unknown> = {}) {
  return { body: { item: { item_id: "history-item", error: null },
    status: { transactions: { last_successful_update: stamp } }, ...extras } };
}
function sourcePage(transactions: unknown[], total = transactions.length, extras: Record<string, unknown> = {}) {
  return { body: { item: { item_id: "history-item", error: null },
    accounts: [account("history-card", { type: "credit", subtype: "credit card" })], transactions, total_transactions: total, ...extras } };
}
async function setup(transactions: ReturnType<typeof txn>[] = []) {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map(t => env.DB.prepare(`DELETE FROM ${t}`)));
  const encrypted = await fernetEncrypt("fictitious-access", E.TOKEN_ENC_KEY!);
  await env.DB.prepare(`INSERT INTO items(id,owner,plaid_account,plaid_item_id,access_token_enc,txn_cursor,status,updated_at,
    transactions_update_status,transactions_history_start_date)
    VALUES(1,'me','me_backup','history-item',?,'stable-cursor','good',?,'HISTORICAL_UPDATE_COMPLETE',?)`)
    .bind(encrypted, new Date().toISOString(), today()).run();
  await env.DB.prepare(`INSERT INTO accounts(id,owner,item_id,plaid_account_id,name,type,subtype)
    VALUES(10,'me',1,'history-card','Fictitious card','credit','credit card')`).run();
  await env.DB.prepare(`INSERT INTO card_liabilities(id,item_id,plaid_account_id,name,statement_issue_date,observed_at)
    VALUES(10,1,'history-card','Fictitious card',?,?)`).bind(dateAgo(30), new Date().toISOString()).run();
  if (transactions.length) await env.DB.batch(transactions.map(t => env.DB.prepare(`INSERT INTO transactions
    (owner,account_id,plaid_txn_id,amount_cents,currency,date,name,merchant_name,category,category_detailed,category_confidence,pending)
    VALUES('me',10,?,?,?,?,?,?,?,?,?,?)`).bind(t.transaction_id, Math.round(t.amount * 100), t.iso_currency_code,
      t.date, t.name, t.merchant_name, (t.personal_finance_category as any)?.primary ?? null,
      (t.personal_finance_category as any)?.detailed ?? null, (t.personal_finance_category as any)?.confidence_level ?? null, t.pending ? 1 : 0)));
  plaid.replies["/item/get"] = itemReply();
  plaid.replies["/transactions/get"] = sourcePage(transactions);
}
const transaction = (id: string, extra: Record<string, unknown> = {}) => txn(id, "history-card", { date: dateAgo(10), ...extra });

beforeEach(() => { plaid = new FakePlaid().install(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("legacy history verification", () => {
  it("reconciles a sparse range, records separate provenance and leaves all existing data untouched", async () => {
    await setup([transaction("only-one", { amount: -25, name: "ONLINE PAYMENT", personal_finance_category: null })]);
    const before = await getItem();
    const oldTransactions = await env.DB.prepare("SELECT * FROM transactions").all();
    const verified = await run();
    expect(verified).toMatchObject({ status: "complete", code: "HISTORY_VERIFIED", checked: 1, total: 1,
      from_date: dateAgo(30), to_date: today() });
    const after = await getItem();
    expect(after).toMatchObject({ transactions_verified_start_date: dateAgo(30), transactions_verified_end_date: today() });
    for (const field of ["txn_cursor", "sync_start_cursor", "updated_at", "transactions_history_start_date", "transactions_history_requested_start_date"])
      expect(after[field]).toEqual(before[field]);
    expect((await env.DB.prepare("SELECT * FROM transactions").all()).results).toEqual(oldTransactions.results);
    expect(await count("history_verification_pages")).toBe(0);
    expect(plaid.calls[1]).toMatchObject({ path: "/transactions/get", clientId: "cid_me_backup", body: {
      start_date: dateAgo(30), end_date: today(), options: { count: 100, offset: 0, account_ids: ["history-card"] } } });
    expect(JSON.stringify(verified)).not.toMatch(/fictitious-access|history-card|stable-cursor|only-one/);
  });

  it("requires every page and resumes without changing coverage after a partial page", async () => {
    const rows = Array.from({ length: 101 }, (_, i) => transaction(`row-${i}`));
    await setup(rows);
    plaid.replyQueues["/transactions/get"] = [sourcePage(rows.slice(0, 100), 101), sourcePage(rows.slice(100), 101)];
    expect(await run()).toMatchObject({ status: "partial", checked: 100, total: 101 });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
    expect(await run()).toMatchObject({ status: "complete", checked: 101, total: 101 });
    expect(plaid.calls.filter(c => c.path === "/transactions/get").map(c => c.body.options.offset)).toEqual([0, 100]);
  });

  it("verifies a genuinely empty ranged feed without inferring a boundary from oldest transaction", async () => {
    await setup();
    expect(await run()).toMatchObject({ status: "complete", checked: 0, total: 0 });
    expect((await getItem()).transactions_verified_start_date).toBe(dateAgo(30));
  });

  it.each([
    ["txn_cursor", null], ["sync_start_cursor", "downloading"], ["transactions_update_status", "INITIAL_UPDATE_COMPLETE"],
    ["status", "login_required"], ["status", "demo"], ["updated_at", "2020-01-01T00:00:00Z"], ["consent_expires_at", "2020-01-01T00:00:00Z"],
  ])("refuses unhealthy local state %s", async (column, value) => {
    await setup(); await setItem(column as string, value);
    expect(await run()).toMatchObject({ status: "needs_sync", code: "TRANSACTIONS_NOT_READY" });
    expect(plaid.calls).toHaveLength(0);
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });

  it("enforces configured item ownership before any source request", async () => {
    await setup();
    expect(await verifyHistoryPage(E, config, 1, "spouse")).toMatchObject({ status: "unavailable" });
    await setItem("owner", "spouse");
    expect(await verifyHistoryPage(E, config, 1)).toMatchObject({ status: "unavailable" });
    expect(plaid.calls).toHaveLength(0);
  });

  it.each([[null, "SOURCE_MARKER_MISSING"], ["invalid", "SOURCE_MARKER_INVALID"], ["2020-01-01T00:00:00Z", "SOURCE_MARKER_STALE"]])("refuses absent or stale source marker %s", async (stamp, code) => {
    await setup(); plaid.replies["/item/get"] = itemReply(stamp);
    expect(await run()).toMatchObject({ code, status: "needs_sync" });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });

  it("uses root status, rejects source errors and unknown source item", async () => {
    await setup();
    plaid.replies["/item/get"] = itemReply(null, { item: { item_id: "history-item", error: null,
      status: { transactions: { last_successful_update: marker() } } } });
    expect(await run()).toMatchObject({ code: "SOURCE_MARKER_MISSING" });
    plaid.replies["/item/get"] = itemReply(marker(), { item: { item_id: "other-item", error: null } });
    expect(await run()).toMatchObject({ code: "SOURCE_ITEM_MISMATCH" });
    plaid.replies["/item/get"] = itemReply(marker(), { item: { item_id: "history-item", error: { error_code: "ITEM_LOGIN_REQUIRED" } } });
    expect(await run()).toMatchObject({ code: "SOURCE_ITEM_ERROR" });
  });

  it("requires no failed source update since the latest success", async () => {
    await setup();
    const success = marker();
    plaid.replies["/item/get"] = itemReply(success, { status: { transactions: {
      last_successful_update: success, last_failed_update: new Date().toISOString() } } });
    expect(await run()).toMatchObject({ code: "SOURCE_UPDATE_FAILED" });
    plaid.replies["/item/get"] = itemReply(success, { status: { transactions: {
      last_successful_update: success, last_failed_update: "invalid" } } });
    expect(await run()).toMatchObject({ code: "SOURCE_FAILURE_MARKER_INVALID" });
    plaid.replies["/item/get"] = itemReply(success, { status: { transactions: {
      last_successful_update: success, last_failed_update: new Date(Date.now() - 120_000).toISOString() } } });
    expect(await run()).toMatchObject({ status: "complete" });
  });

  it("distinguishes missing item status and future markers without disclosing source values", async () => {
    await setup();
    plaid.replies["/item/get"] = itemReply(marker(), { item: { item_id: "history-item" } });
    expect(await run()).toMatchObject({ code: "SOURCE_ITEM_STATUS_MISSING" });
    const future = new Date(Date.now() + 120_000).toISOString();
    plaid.replies["/item/get"] = itemReply(future);
    const failure = await run();
    expect(failure).toMatchObject({ code: "SOURCE_MARKER_FUTURE" });
    expect(JSON.stringify(failure)).not.toContain(future);
  });

  it("retains the precise guard failure after a page without granting coverage", async () => {
    await setup();
    plaid.replyQueues["/item/get"] = [itemReply(marker()), itemReply(null)];
    expect(await run()).toMatchObject({ status: "needs_sync", code: "SOURCE_MARKER_MISSING" });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
    expect(await count("history_verification_seen")).toBe(0);
  });

  it.each([
    [{ amount: 99 }, "HISTORY_AMOUNT_CHANGED"], [{ name: "Modified" }, "HISTORY_NAME_CHANGED"],
    [{ merchant_name: null }, "HISTORY_MERCHANT_CHANGED"], [{ date: dateAgo(9) }, "HISTORY_DATE_CHANGED"],
    [{ iso_currency_code: "CAD" }, "HISTORY_CURRENCY_CHANGED"], [{ pending: true }, "HISTORY_PENDING_CHANGED"],
    [{ account_id: "unrecognized" }, "HISTORY_UNREQUESTED_TRANSACTION"], [{ transaction_id: "missing" }, "HISTORY_TRANSACTION_MISSING"],
    [{ personal_finance_category: { primary: "OTHER" } }, "HISTORY_CLASSIFICATION_CHANGED"],
  ] as [Record<string, unknown>, string][])("does not verify changed source values %j", async (change, code) => {
    const t = transaction("one"); await setup([t]);
    plaid.replies["/transactions/get"] = sourcePage([{ ...t, ...change }]);
    expect(await run()).toMatchObject({ status: "needs_sync", code });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
    expect(await count("history_verification_pages")).toBe(0);
  });

  it("includes pending rows in completeness checks", async () => {
    const t = transaction("pending", { pending: true }); await setup([t]);
    expect(await run()).toMatchObject({ status: "complete", checked: 1 });
  });

  it("permits null legacy classifications when inclusion is unchanged", async () => {
    const t = transaction("payment", { amount: -25, name: "ONLINE PAYMENT", personal_finance_category: null });
    await setup([t]);
    plaid.replies["/transactions/get"] = sourcePage([{ ...t, personal_finance_category: {
      primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence_level: "HIGH" } }]);
    expect(await run()).toMatchObject({ status: "complete" });
    expect((await env.DB.prepare("SELECT category_detailed FROM transactions").first<any>()).category_detailed).toBeNull();
  });

  it("does not verify legacy classification that would deduct a source refund", async () => {
    const t = transaction("payment-row", { amount: -25, name: "ONLINE PAYMENT", personal_finance_category: null });
    await setup([t]);
    plaid.replies["/transactions/get"] = sourcePage([{ ...t, personal_finance_category: { primary: "TRANSFER_IN", detailed: "REFUND" } }]);
    expect(await run()).toMatchObject({ status: "needs_sync", code: "PAYMENT_CLASSIFICATION_CHANGED" });
  });

  it("does not let missing legacy confidence overstate source payment confidence", async () => {
    const t = transaction("payment-row", { amount: -25, name: "ONLINE PAYMENT", personal_finance_category: {
      primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" } });
    await setup([t]);
    plaid.replies["/transactions/get"] = sourcePage([{ ...t, personal_finance_category: {
      primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", confidence_level: "LOW" } }]);
    expect(await run()).toMatchObject({ status: "needs_sync", code: "PAYMENT_CLASSIFICATION_CHANGED" });
  });

  it.each([
    [{ accounts: [] }, "HISTORY_SAVED_CREDIT_ACCOUNT_MISSING"], [{ accounts: [account("unknown")] }, "HISTORY_SAVED_CREDIT_ACCOUNT_MISSING"],
    [{ accounts: [{ name: "Invalid account" }] }, "HISTORY_SOURCE_ACCOUNT_INVALID"],
    [{ accounts: [{ account_id: 123 }] }, "HISTORY_SOURCE_ACCOUNT_INVALID"],
    [{ accounts: [{ account_id: "" }] }, "HISTORY_SOURCE_ACCOUNT_INVALID"],
    [{ item: { item_id: "other", error: null } }, "HISTORY_ITEM_MISMATCH"],
    [{ item: { item_id: "history-item", error: { error_code: "fake-private-error" } } }, "HISTORY_ITEM_ERROR"],
    [{ transactions: null }, "HISTORY_PAGE_INVALID"], [{ total_transactions: 1.1 }, "HISTORY_PAGE_INVALID"],
    [{ total_transactions: -1 }, "HISTORY_PAGE_INVALID"],
  ] as [Record<string, unknown>, string][])("rejects malformed or mismatched source metadata %j", async (extra, code) => {
    await setup(); plaid.replies["/transactions/get"] = sourcePage([], 0, extra);
    expect(await run()).toMatchObject({ status: "needs_sync", code });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });

  it("distinguishes saved account ownership from an unknown source account", async () => {
    await setup();
    await env.DB.prepare("UPDATE accounts SET owner='spouse' WHERE id=10").run();
    expect(await run()).toMatchObject({ status: "needs_sync", code: "HISTORY_ACCOUNT_OWNER_CHANGED" });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
    expect(await count("history_verification_pages")).toBe(0);
    expect(plaid.calls).toHaveLength(0);
  });

  it("accepts unrelated account metadata while verifying only the explicitly requested saved accounts", async () => {
    const t = transaction("one"); await setup([t]);
    const before = await getItem();
    plaid.replies["/transactions/get"] = sourcePage([t], 1, { accounts: [account("unrelated-new-account"), account("history-card", { type: "credit" })] });
    expect(await run()).toMatchObject({ status: "complete", checked: 1 });
    expect(plaid.calls.find(c => c.path === "/transactions/get")!.body.options.account_ids).toEqual(["history-card"]);
    expect(await count("accounts")).toBe(1);
    const after = await getItem();
    expect(after.txn_cursor).toBe(before.txn_cursor);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("rejects transactions from unrelated accounts even when source metadata includes them", async () => {
    await setup();
    plaid.replies["/transactions/get"] = sourcePage([transaction("outside", { account_id: "unrelated-new-account" })], 1,
      { accounts: [account("unrelated-new-account"), account("history-card", { type: "credit" })] });
    expect(await run()).toMatchObject({ status: "needs_sync", code: "HISTORY_UNREQUESTED_TRANSACTION" });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
    expect(await count("transactions")).toBe(0);
  });

  it("requests captured saved account IDs in deterministic order across pages", async () => {
    const rows = [transaction("one"), transaction("two")]; await setup(rows);
    await env.DB.prepare(`INSERT INTO accounts(id,owner,item_id,plaid_account_id,name,type)
      VALUES(11,'me',1,'z-card','Fictitious card','credit'),(12,'me',1,'a-checking','Fictitious checking','depository')`).run();
    const accounts = [account("history-card", { type: "credit" }), account("z-card", { type: "credit" }), account("a-checking")];
    plaid.replyQueues["/transactions/get"] = [sourcePage([rows[0]], 2, { accounts }), sourcePage([rows[1]], 2, { accounts })];
    expect(await run()).toMatchObject({ status: "partial" });
    expect(await run()).toMatchObject({ status: "complete" });
    expect(plaid.calls.filter(c => c.path === "/transactions/get").map(c => c.body.options.account_ids))
      .toEqual([["a-checking", "history-card", "z-card"], ["a-checking", "history-card", "z-card"]]);
  });

  it("rejects duplicate IDs within a page", async () => {
    const t = transaction("one"); await setup([t]); plaid.replies["/transactions/get"] = sourcePage([t, t], 2);
    expect(await run()).toMatchObject({ code: "HISTORY_DUPLICATE_TRANSACTIONS" });
  });

  it("rejects duplicate IDs across pages", async () => {
    const t = transaction("one"); await setup([t]);
    plaid.replyQueues["/transactions/get"] = [sourcePage([t], 2), sourcePage([t], 2)];
    expect(await run()).toMatchObject({ status: "partial" });
    expect(await run()).toMatchObject({ code: "HISTORY_DUPLICATE_TRANSACTIONS" });
  });

  it.each(["count", "empty", "source", "cursor", "timestamp", "account"])("rejects changing %s between pages", async change => {
    const rows = [transaction("one"), transaction("two")]; await setup(rows);
    plaid.replies["/transactions/get"] = sourcePage([rows[0]], 2);
    expect(await run()).toMatchObject({ status: "partial" });
    plaid.replies["/transactions/get"] = sourcePage([rows[1]], 2);
    if (change === "count") plaid.replies["/transactions/get"] = sourcePage([rows[1]], 3);
    if (change === "empty") plaid.replies["/transactions/get"] = sourcePage([], 2);
    if (change === "source") plaid.replies["/item/get"] = itemReply(new Date().toISOString());
    if (change === "cursor") await setItem("txn_cursor", "advanced");
    if (change === "timestamp") await setItem("updated_at", new Date(Date.now() - 1000).toISOString());
    if (change === "account") await env.DB.prepare("UPDATE accounts SET subtype='other' WHERE id=10").run();
    const failure = await run();
    expect(failure.status).not.toBe("complete");
    if (change === "count") expect(failure.code).toBe("HISTORY_TOTAL_CHANGED");
    if (change === "empty") expect(failure.code).toBe("HISTORY_PAGE_MISSING");
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });

  it("keeps mismatch diagnostics categorical without returning source or local values", async () => {
    const t = transaction("private-id"); await setup([t]);
    plaid.replies["/transactions/get"] = sourcePage([{ ...t, name: "Private changed description" }]);
    const failure = await run();
    expect(failure.code).toBe("HISTORY_NAME_CHANGED");
    expect(JSON.stringify(failure)).not.toMatch(/private-id|Private changed description|history-card|fictitious-access/);
    expect((await env.DB.prepare("SELECT failure_code FROM history_verifications").first<any>()).failure_code)
      .toBe("HISTORY_NAME_CHANGED");
    expect(await count("history_verification_pages")).toBe(0);
  });

  it("checks the source marker again after a page", async () => {
    await setup();
    plaid.replyQueues["/item/get"] = [itemReply(marker()), itemReply(new Date().toISOString())];
    expect(await run()).toMatchObject({ status: "retry", code: "SOURCE_CHANGED" });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });

  it("refuses incomplete local membership even when Plaid total is smaller", async () => {
    await setup([transaction("missing-in-source")]); plaid.replies["/transactions/get"] = sourcePage([]);
    expect(await run()).toMatchObject({ status: "needs_sync", code: "LOCAL_DATA_CHANGED" });
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });

  it("preserves previous verified interval on source errors", async () => {
    await setup(); await setItem("transactions_verified_start_date", dateAgo(5));
    plaid.replies["/transactions/get"] = plaidError("INSTITUTION_DOWN");
    expect(await run()).toMatchObject({ status: "retry", code: "VERIFICATION_FAILED" });
    expect((await getItem()).transactions_verified_start_date).toBe(dateAgo(5));
  });

  it("does not share an active lease and expires partial runs without granting coverage", async () => {
    const rows = [transaction("one"), transaction("two")]; await setup(rows);
    plaid.replies["/transactions/get"] = sourcePage([rows[0]], 2);
    expect(await run()).toMatchObject({ status: "partial" });
    await env.DB.prepare("UPDATE history_verifications SET lease_token='other-request',lease_expires_at=?").bind(Date.now() + 60_000).run();
    const calls = plaid.calls.length;
    expect(await run()).toMatchObject({ status: "busy" });
    expect(plaid.calls).toHaveLength(calls);
    await env.DB.prepare("UPDATE history_verifications SET expires_at=?").bind(Date.now() - 1).run();
    expect(await run()).toMatchObject({ status: "retry", code: "VERIFICATION_EXPIRED" });
    expect(await count("history_verification_seen")).toBe(0);
    expect((await getItem()).transactions_verified_start_date).toBeNull();
  });
});
