import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { loadConfig } from "../src/config";
import { fernetEncrypt } from "../src/fernet";
import { CATCH_UP_CRON, checkConnections, checkItem, runSyncAll, syncItem, type ItemRow } from "../src/sync";
import type { Env } from "../src/env";
import { FakePlaid, account, page, plaidError, txn } from "./fake-plaid";

// Cursor-based sync, against a real local D1.
const E = env as unknown as Env;
const config = loadConfig(E);
let plaid: FakePlaid;

async function wipe() {
  await env.DB.batch(["transaction_tags", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

async function addItem(o: { owner?: string; plaid_account?: string; cursor?: string | null; start?: string | null; status?: string;
                              token?: string; updated_at?: string; attempted_at?: string } = {}): Promise<ItemRow> {
  const enc = o.token ?? await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  return (await env.DB.prepare(
    `INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, txn_cursor, sync_start_cursor, status, updated_at, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(o.owner ?? "me", o.plaid_account ?? "me_backup", `item-${crypto.randomUUID()}`, enc, o.cursor ?? null, o.start ?? null,
    o.status ?? "good", o.updated_at ?? "2026-09-01T00:00:00.000Z", o.attempted_at ?? null).first<ItemRow>())!;
}

const mutation = () => plaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 400, "TRANSACTIONS_ERROR");

const rows = async (sql: string) => (await env.DB.prepare(sql).all<any>()).results;
const itemById = async (id: number) => env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<any>();

beforeEach(async () => { await wipe(); plaid = new FakePlaid().install(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("syncItem", () => {
  it("syncs every page, persisting each (cursor last) with the item's own credentials", async () => {
    const item = await addItem({ owner: "me", plaid_account: "me_backup" });
    plaid.syncPages.push(
      page("c1", true, { accounts: [account("a1")], added: [txn("t0", "a1"), txn("t1", "a1", { amount: 84.12, pending: true }), txn("orphan", "unknown-acct")] }),
      page("c2", false, { accounts: [account("a1", { balances: { current: 5, available: null, iso_currency_code: "USD" } })],
        modified: [txn("t1", "a1", { amount: 80, name: "Edited" })], removed: ["t0"] }),
    );
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");

    expect(plaid.calls.map((c) => [c.clientId, c.body.cursor])).toEqual([["cid_me_backup", undefined], ["cid_me_backup", "c1"]]);
    expect(plaid.calls[0].body).toMatchObject({ access_token: "access-sandbox-secret", count: 100 });
    expect((await itemById(item.id)).txn_cursor).toBe("c2");

    const txns = await rows("SELECT * FROM transactions");
    expect(txns).toHaveLength(1);                                   // t0 removed, orphan skipped
    expect(txns[0]).toMatchObject({ plaid_txn_id: "t1", owner: "me", amount_cents: 8000, name: "Edited",
      category: "FOOD_AND_DRINK", pending: 0, currency: "USD", date: "2026-09-20" });
    const [acct] = await rows("SELECT * FROM accounts");
    expect(acct).toMatchObject({ plaid_account_id: "a1", owner: "me", item_id: item.id, balance_current_cents: 500,
      balance_available_cents: null, type: "depository", subtype: "checking" });
  });

  it("stores amounts as exact cents and pending as 0/1", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")],
      added: [txn("x", "a1", { amount: 0.1 + 0.2 }), txn("y", "a1", { amount: -2450.005, pending: true })] }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await rows("SELECT plaid_txn_id, amount_cents, pending FROM transactions ORDER BY plaid_txn_id"))
      .toEqual([{ plaid_txn_id: "x", amount_cents: 30, pending: 0 }, { plaid_txn_id: "y", amount_cents: -245001, pending: 1 }]);
  });

  it("retains reported credit limits, including zero, and clears missing limits on refresh", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("card", { type: "credit", subtype: "credit card",
      balances: { current: 200.25, available: 799.75, limit: 1000.01, iso_currency_code: "USD" } })] }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await rows("SELECT credit_limit_cents FROM accounts")).toEqual([{ credit_limit_cents: 100001 }]);
    for (const limit of [0, null]) {
      plaid.syncPages.push(page("c2", false, { accounts: [account("card", { balances: { limit } })] }));
      await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
      expect(await rows("SELECT credit_limit_cents FROM accounts")).toEqual([{ credit_limit_cents: limit }]);
    }
  });

  it("updates detailed classification and confidence through posting, corrections and removals without duplicates", async () => {
    const item = await addItem();
    const payment = { amount: -50, name: "Payment thank you", personal_finance_category: {
      primary: "TRANSFER_IN", detailed: "TRANSFER_IN_CREDIT_CARD_PAYMENT", confidence_level: "VERY_HIGH" } };
    plaid.syncPages.push(page("c1", false, { accounts: [account("card", { type: "credit" })],
      added: [txn("pending-payment", "card", { ...payment, pending: true })] }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await rows("SELECT category_detailed, category_confidence, pending FROM transactions"))
      .toEqual([{ category_detailed: "TRANSFER_IN_CREDIT_CARD_PAYMENT", category_confidence: "VERY_HIGH", pending: 1 }]);

    const posted = txn("posted-payment", "card", { ...payment, pending_transaction_id: "pending-payment" });
    plaid.syncPages.push(page("c2", true, { added: [posted], removed: ["pending-payment"] }),
      page("c3", false, { added: [posted] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 2 });
    expect(await rows("SELECT plaid_txn_id, amount_cents, pending, pending_txn_id FROM transactions"))
      .toEqual([{ plaid_txn_id: "posted-payment", amount_cents: -5000, pending: 0, pending_txn_id: "pending-payment" }]);

    plaid.syncPages.push(page("c4", false, { modified: [txn("posted-payment", "card", {
      amount: -25, iso_currency_code: "CAD", personal_finance_category: {
        primary: "TRANSFER_IN", detailed: "TRANSFER_IN_OTHER_TRANSFER_IN", confidence_level: "LOW" } })] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await rows("SELECT amount_cents, currency, category_detailed, category_confidence FROM transactions"))
      .toEqual([{ amount_cents: -2500, currency: "CAD", category_detailed: "TRANSFER_IN_OTHER_TRANSFER_IN", category_confidence: "LOW" }]);

    plaid.syncPages.push(page("c5", false, { modified: [txn("posted-payment", "card", { personal_finance_category: null })] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await rows("SELECT category_detailed, category_confidence FROM transactions"))
      .toEqual([{ category_detailed: null, category_confidence: null }]);
    plaid.syncPages.push(page("c6", false, { removed: ["posted-payment"] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await rows("SELECT * FROM transactions")).toEqual([]);
  });

  it("requires explicit historical completion and the last page before establishing coverage", async () => {
    const item = await addItem();
    await env.DB.prepare("UPDATE items SET transactions_history_requested_start_date = '2024-10-15' WHERE id = ?").bind(item.id).run();
    for (const update_status of ["NOT_READY", "INITIAL_UPDATE_COMPLETE"]) {
      plaid.syncPages.push(page(update_status, false, { update_status }));
      await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
      expect(await itemById(item.id)).toMatchObject({ transactions_update_status: update_status,
        transactions_history_start_date: null, sync_start_cursor: null });
    }
    plaid.syncPages.push(page("partial-history", true));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      transactions_history_start_date: null, sync_start_cursor: "INITIAL_UPDATE_COMPLETE" });
    plaid.syncPages.push(page("complete-history", false));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ transactions_history_start_date: "2024-10-15", sync_start_cursor: null });
  });

  it("gives legacy Items a conservative coverage boundary without resetting cursors or deleting old transactions", async () => {
    const item = await addItem({ cursor: "existing-cursor" });
    plaid.syncPages.push(page("same-history", false, { accounts: [account("a1")],
      added: [txn("old", "a1", { date: "2020-01-01" })], update_status: null }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ transactions_history_start_date: null, transactions_update_status: null });
    plaid.syncPages.push(page("complete", false));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    const { today } = (await env.DB.prepare("SELECT date('now') AS today").first<{ today: string }>())!;
    expect(await itemById(item.id)).toMatchObject({ transactions_history_start_date: today,
      transactions_history_requested_start_date: null, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
    expect(plaid.calls.map(c => c.body.cursor)).toEqual(["existing-cursor", "same-history"]);
    expect(await rows("SELECT plaid_txn_id FROM transactions")).toEqual([{ plaid_txn_id: "old" }]);
    plaid.syncPages.push(page("later", false, { update_status: null }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ transactions_history_start_date: today, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" });
  });

  it("stores Plaid's account_owner (the card member on multi-card accounts), and updates it on modify", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [
      txn("main", "a1", { account_owner: "ALEX MORGAN" }),
      txn("au", "a1", { account_owner: "SAM MORGAN -1013" }),
      txn("none", "a1"),                                         // most banks leave it out
      txn("nul", "a1", { account_owner: null }),
    ] }));
    await syncItem(E, config, item, { pages: 1 });
    expect(await rows("SELECT plaid_txn_id, account_owner FROM transactions ORDER BY plaid_txn_id")).toEqual([
      { plaid_txn_id: "au", account_owner: "SAM MORGAN -1013" },
      { plaid_txn_id: "main", account_owner: "ALEX MORGAN" },
      { plaid_txn_id: "none", account_owner: null },
      { plaid_txn_id: "nul", account_owner: null },
    ]);
    plaid.syncPages.push(page("c2", false, { accounts: [account("a1")], modified: [txn("none", "a1", { account_owner: "SAM MORGAN -1013" })] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect((await rows("SELECT account_owner FROM transactions WHERE plaid_txn_id = 'none'"))[0].account_owner).toBe("SAM MORGAN -1013");
  });

  it("never touches user tags when Plaid modifies a transaction", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    await syncItem(E, config, item, { pages: 1 });
    const [{ id }] = await rows("SELECT id FROM transactions");
    await env.DB.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, 'travel', 0)").bind(id).run();
    plaid.syncPages.push(page("c2", false, { accounts: [account("a1")], modified: [txn("t1", "a1", { amount: 99 })] }));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await rows("SELECT tag FROM transaction_tags")).toEqual([{ tag: "travel" }]);
    expect((await rows("SELECT amount_cents FROM transactions"))[0].amount_cents).toBe(9900);
  });

  it("resumes from the stored cursor", async () => {
    const item = await addItem({ cursor: "c8" });
    plaid.syncPages.push(page("c9", false));
    await syncItem(E, config, item, { pages: 5 });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c8"]);
  });

  it("stops at the page budget and resumes next run", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true), page("c2", true), page("c3", false));
    const budget = { pages: 2 };
    expect(await syncItem(E, config, item, budget)).toBe("partial");
    expect(budget.pages).toBe(0);
    expect((await itemById(item.id)).txn_cursor).toBe("c2");
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 2 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual([undefined, "c1", "c2"]);
  });

  it("keeps pages already saved when a later page fails transiently", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }), plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR"));
    expect(await syncItem(E, config, item, { pages: 5 })).toBe("retry");
    const after = await itemById(item.id);
    expect([after.txn_cursor, after.status]).toEqual(["c1", "good"]);
    expect(await rows("SELECT plaid_txn_id FROM transactions")).toEqual([{ plaid_txn_id: "t1" }]);
  });

  it.each([
    ["ITEM_LOGIN_REQUIRED", "login_required", "login_required"],
    ["ITEM_NOT_FOUND", "error", "error"],
    ["INTERNAL_SERVER_ERROR", "retry", "good"],         // transient: retried, not marked 'error'
    ["PRODUCT_NOT_READY", "retry", "good"],             // normal right after linking
    ["RATE_LIMIT_EXCEEDED", "retry", "good"],
  ])("maps %s to result %s and status %s", async (code, result, status) => {
    const item = await addItem();
    plaid.syncPages.push(plaidError(code));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe(result);
    expect((await itemById(item.id)).status).toBe(status);
  });

  it("restarts pagination from the loop's first cursor on TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", async () => {
    const item = await addItem({ cursor: "c0" });
    plaid.syncPages.push(page("c1", true), mutation(), page("c1b", true), page("c2", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c0", "c1", "c0", "c1b"]);
  });

  it("stops when the run's byte budget is spent, then resumes next run", async () => {
    const item = await addItem();
    const big = Array.from({ length: 50 }, (_, i) => txn(`b-${i}`, "a1"));
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: big }), page("c2", true), page("c3", false));
    const budget = { pages: 10, bytes: 1_000 };                     // smaller than one page
    expect(await syncItem(E, config, item, budget)).toBe("partial");
    expect(plaid.calls).toHaveLength(1);                             // always at least one page
    expect(budget.bytes).toBeLessThanOrEqual(0);
    expect((await itemById(item.id)).txn_cursor).toBe("c1");
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 10, bytes: 1_000_000 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual([undefined, "c1", "c2"]);
  });

  it("uses SYNC_MAX_BYTES_PER_RUN / SYNC_MAX_PAGES_PER_RUN for the cron budget", async () => {
    await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }), page("c2", true), page("c3", false));
    await runSyncAll({ ...E, SYNC_MAX_BYTES_PER_RUN: "1", SYNC_MAX_PAGES_PER_RUN: "10" });
    expect(plaid.calls).toHaveLength(1);
    plaid.calls = [];
    await wipe(); await addItem();
    plaid.syncPages = [page("c1", true), page("c2", true), page("c3", false)];
    await runSyncAll({ ...E, SYNC_MAX_PAGES_PER_RUN: "2" });
    expect(plaid.calls).toHaveLength(2);
  });

  it("leaves no scratch rows behind (full sync and budget cut-off)", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }), page("c2", true));
    expect(await syncItem(E, config, item, { pages: 2 })).toBe("partial");
    expect(await rows("SELECT * FROM sync_pages")).toEqual([]);
  });

  it.each([
    ["not JSON at all", "<html>oops</html>"],
    ["JSON without a next_cursor", { added: [], has_more: false }],
    ["a JSON string", "just text"],
  ])("never moves the cursor or writes anything for a malformed page (%s)", async (_, body) => {
    const item = await addItem({ cursor: "c5" });
    plaid.syncPages.push(page("c6", true, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    plaid.syncPages[0] = { body };
    expect(await syncItem(E, config, item, { pages: 3 })).toBe("retry");
    expect((await itemById(item.id))).toMatchObject({ txn_cursor: "c5", status: "good" });
    expect(await rows("SELECT * FROM transactions")).toEqual([]);
    expect(await rows("SELECT * FROM sync_pages")).toEqual([]);
    expect(plaid.calls).toHaveLength(1);                             // stops; the next run retries
  });

  it("persists a large page (500 transactions) exactly", async () => {
    const item = await addItem();
    const added = Array.from({ length: 500 }, (_, i) => txn(`big-${i}`, i % 2 ? "a1" : "a2", { amount: i + 0.01 }));
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1"), account("a2")], added }));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("good");
    const [{ n, total }] = await rows("SELECT count(*) AS n, sum(amount_cents) AS total FROM transactions");
    expect(n).toBe(500);
    expect(total).toBe(Array.from({ length: 500 }, (_, i) => i * 100 + 1).reduce((a, b) => a + b, 0));
    expect((await itemById(item.id)).txn_cursor).toBe("c1");
  });

  it("marks an item whose token doesn't decrypt as error, without calling Plaid", async () => {
    const item = await addItem({ token: await fernetEncrypt("x", "dGhpcy1pcy1hbm90aGVyLXRlc3Qta2V5LTMyYnl0ZXM=") });
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("error");
    expect(plaid.calls).toEqual([]);
  });
});

describe("updates spread over several runs (TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION)", () => {
  it("keeps the cursor an update began from until it's caught up", async () => {
    const item = await addItem({ cursor: "c5" });
    plaid.syncPages.push(page("c6", true), page("c7", true), page("c8", false));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("partial");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c6", sync_start_cursor: "c5" });
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("partial");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c7", sync_start_cursor: "c5" });
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("good");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c8", sync_start_cursor: null });
  });

  it("records the first history download as starting from the beginning ('')", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true));
    await syncItem(E, config, item, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c1", sync_start_cursor: "" });
  });

  it("restarts a history download from the beginning when Plaid's data changed between runs", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", true, { accounts: [account("a1")], added: [txn("old", "a1")] }));
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("partial");          // run 1, e.g. at link time
    plaid.syncPages.push(mutation(), page("r1", true, { accounts: [account("a1")], added: [txn("old", "a1")] }),
      page("r2", false, { accounts: [account("a1")], added: [txn("new", "a1")] }));
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 10 })).toBe("good");   // run 2
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual([undefined, "c1", undefined, "r1"]);
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "r2", sync_start_cursor: null, last_error: null, status: "good" });
    expect(await rows("SELECT plaid_txn_id FROM transactions ORDER BY plaid_txn_id")).toEqual([{ plaid_txn_id: "new" }, { plaid_txn_id: "old" }]);
  });

  it("restarts a later update from its own start, not from the beginning", async () => {
    const item = await addItem({ cursor: "c6", start: "c5" });
    plaid.syncPages.push(mutation(), page("c6b", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c6", "c5"]);
  });

  it("restarts from the beginning when the start isn't on record (downloads from before migration 0004)", async () => {
    const item = await addItem({ cursor: "stuck-mid-download" });
    plaid.syncPages.push(mutation(), page("r1", false));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["stuck-mid-download", undefined]);
  });

  it("saves the restart point when the run's budget ends at the error", async () => {
    const item = await addItem({ cursor: "c1", start: "" });
    plaid.syncPages.push(mutation());
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("partial");
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: null, sync_start_cursor: "",
      last_error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", status: "good" });
    plaid.syncPages.push(page("r1", false));
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("good");
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["c1", undefined]);
  });

  it("restarts at most once per run, then records the error and leaves the last successful sync alone", async () => {
    const item = await addItem({ cursor: "c1", start: "" });
    plaid.syncPages.push(mutation(), mutation());
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("retry");
    expect(plaid.calls).toHaveLength(2);
    const after = await itemById(item.id);
    expect(after).toMatchObject({ status: "good", updated_at: "2026-09-01T00:00:00.000Z",
      last_error: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", txn_cursor: null, sync_start_cursor: "" });
    expect(after.attempted_at).toBeTruthy();
    expect(after.last_error_at).toBeTruthy();
  });

  it("records other failures without retrying them in the same run", async () => {
    const item = await addItem({ cursor: "c1" });
    plaid.syncPages.push(plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR"));
    expect(await syncItem(E, config, item, { pages: 10 })).toBe("retry");
    expect(plaid.calls).toHaveLength(1);
    expect(await itemById(item.id)).toMatchObject({ txn_cursor: "c1", last_error: "INTERNAL_SERVER_ERROR",
      updated_at: "2026-09-01T00:00:00.000Z" });
  });
});

describe("syncItem with more slots", () => {
  it("syncs an item on a third slot with that slot's keys, and skips it once the slot is removed", async () => {
    const e = { ...E, PLAID_SLOTS: "primary,backup,extra1", PLAID_CLIENT_ID_ME_EXTRA1: "cid_me_extra1", PLAID_SECRET_ME_EXTRA1: "s" };
    const item = await addItem({ plaid_account: "me_extra1" });
    plaid.syncPages.push(page("c1", false));
    expect(await syncItem(e, loadConfig(e), item, { pages: 1 })).toBe("good");
    expect(plaid.calls[0].clientId).toBe("cid_me_extra1");
    expect(await syncItem(E, config, (await itemById(item.id))!, { pages: 1 })).toBe("skipped");   // default slots only
    expect((await itemById(item.id)).status).toBe("good");                                          // untouched, not errored
  });
});

describe("runSyncAll / cron", () => {
  it("sweeps syncable items least-recently-updated first, skipping errored, demo and removed users' items", async () => {
    const newer = await addItem({ updated_at: "2026-09-20T00:00:00.000Z" });
    const older = await addItem({ updated_at: "2026-09-10T00:00:00.000Z", plaid_account: "me_primary" });
    const relogin = await addItem({ status: "login_required", updated_at: "2026-09-15T00:00:00.000Z" });
    await addItem({ status: "error" });
    await addItem({ status: "demo" });
    const gone = await addItem({ owner: "alex", plaid_account: "alex_primary", updated_at: "2026-09-01T00:00:00.000Z" });
    plaid.syncPages.push(page("a", false), page("b", false), page("c", false));
    expect(await runSyncAll(E)).toEqual({ [gone.id]: "skipped", [older.id]: "good", [relogin.id]: "good", [newer.id]: "good" });
    expect(plaid.calls.map((c) => c.clientId)).toEqual(["cid_me_primary", "cid_me_backup", "cid_me_backup"]);
    expect((await itemById(relogin.id)).status).toBe("good");          // reconnected -> healthy again
  });

  it("shares one page budget across items", async () => {
    const a = await addItem({ updated_at: "2026-09-01T00:00:00.000Z" });
    const b = await addItem({ updated_at: "2026-09-02T00:00:00.000Z" });
    plaid.syncPages.push(page("a1", true), page("a2", true), page("b1", false));
    expect(await runSyncAll(E, { pages: 2 })).toEqual({ [a.id]: "partial" });
    expect((await itemById(b.id)).txn_cursor).toBeNull();
  });

  it("runs from the scheduled handler", async () => {
    const item = await addItem();
    plaid.syncPages.push(page("c1", false, { accounts: [account("a1")], added: [txn("t1", "a1")] }));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect((await itemById(item.id)).txn_cursor).toBe("c1");
  });

  it("puts a bank that failed behind the others, so it can't hold them up", async () => {
    const stuck = await addItem({ cursor: "mid", updated_at: "2026-09-01T00:00:00.000Z" });
    const ok = await addItem({ cursor: "k1", updated_at: "2026-09-02T00:00:00.000Z" });
    plaid.syncPages.push(plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR"));
    expect(await runSyncAll(E, { pages: 1 })).toEqual({ [stuck.id]: "retry" });
    plaid.syncPages.push(page("k2", false));
    expect(await runSyncAll(E, { pages: 1 })).toEqual({ [ok.id]: "good" });           // ok goes first now
  });

  it("syncs caught-up banks before unfinished downloads in the hourly sweep", async () => {
    const downloading = await addItem({ cursor: "d1", start: "", attempted_at: "2026-09-01T00:00:00.000Z" });
    const caughtUp = await addItem({ cursor: "k1", attempted_at: "2026-09-05T00:00:00.000Z" });
    plaid.syncPages.push(page("k2", false), page("d2", false));
    expect(await runSyncAll(E, { pages: 10 })).toEqual({ [caughtUp.id]: "good", [downloading.id]: "good" });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["k1", "d1"]);   // caught-up first, though attempted later
  });

  it("catch-up runs only continue unfinished downloads", async () => {
    await addItem({ cursor: "k1" });
    const downloading = await addItem({ cursor: "d1", start: "" });
    plaid.syncPages.push(page("d2", false));
    expect(await runSyncAll(E, { pages: 10 }, { updatesOnly: true })).toEqual({ [downloading.id]: "good" });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["d1"]);
    plaid.calls = [];
    expect(await runSyncAll(E, { pages: 10 }, { updatesOnly: true })).toEqual({});   // caught up: no Plaid calls
    expect(plaid.calls).toEqual([]);
  });

  it("the catch-up trigger syncs only downloads; the hourly one syncs every bank", async () => {
    const caughtUp = await addItem({ cursor: "k1" });
    const downloading = await addItem({ cursor: "d1", start: "" });
    const run = async (cron: string, e: Env = E) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ cron }), e, ctx);
      await waitOnExecutionContext(ctx);
    };
    plaid.syncPages.push(page("d2", true));
    await run(CATCH_UP_CRON, { ...E, SYNC_MAX_PAGES_PER_RUN: "1" });
    expect(plaid.calls.map((c) => c.body.cursor)).toEqual(["d1"]);
    plaid.syncPages.push(page("k2", false), page("d3", false));
    await run("17 * * * *");
    expect(plaid.calls.filter((c) => c.path === "/transactions/sync").map((c) => c.body.cursor)).toEqual(["d1", "k1", "d2"]);
    expect(plaid.paths().at(-1)).toBe("/item/get");                  // then one connection check
    expect((await itemById(caughtUp.id)).txn_cursor).toBe("k2");
    expect((await itemById(downloading.id))).toMatchObject({ txn_cursor: "d3", sync_start_cursor: null });
  });
});

describe("error text for the dashboard", () => {
  it("keeps Plaid's message with the code, preferring its display_message, and clears both on success", async () => {
    const item = await addItem({ cursor: "c1" });
    plaid.syncPages.push({ status: 400, body: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", request_id: "r",
      error_message: "the login details of this item have changed", display_message: "Please sign in again." } });
    expect(await syncItem(E, config, item, { pages: 1 })).toBe("login_required");
    expect(await itemById(item.id)).toMatchObject({ status: "login_required", last_error: "ITEM_LOGIN_REQUIRED", last_error_message: "Please sign in again." });
    plaid.syncPages.push(page("c2", false));
    await syncItem(E, config, (await itemById(item.id))!, { pages: 1 });
    expect(await itemById(item.id)).toMatchObject({ status: "good", last_error: null, last_error_message: null, last_error_at: null });
  });

  it("caps Plaid's message at 200 characters", async () => {
    const item = await addItem({ cursor: "c1" });
    plaid.syncPages.push({ status: 500, body: { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR", error_message: "x".repeat(500) } });
    await syncItem(E, config, item, { pages: 1 });
    expect((await itemById(item.id)).last_error_message).toHaveLength(200);
  });
});

describe("daily connection check (/item/get)", () => {
  const itemGet = (item: Record<string, unknown>) => ({ body: { item: { item_id: "x", error: null, consent_expiration_time: null, ...item } } });

  it("records the consent end of a healthy bank, with the bank's own keys", async () => {
    const item = await addItem({ plaid_account: "me_primary" });
    plaid.replies["/item/get"] = itemGet({ consent_expiration_time: "2027-04-01T00:00:00Z" });
    expect(await checkItem(E, config, item)).toBeNull();
    expect(plaid.calls[0]).toMatchObject({ path: "/item/get", clientId: "cid_me_primary", body: { access_token: "access-sandbox-secret" } });
    const after = await itemById(item.id);
    expect(after).toMatchObject({ consent_expires_at: "2027-04-01T00:00:00Z", status: "good" });
    expect(after.checked_at).toBeTruthy();
  });

  it("puts a reconnected bank back to good", async () => {
    const item = await addItem({ status: "login_required" });
    await env.DB.prepare("UPDATE items SET last_error = 'ITEM_LOGIN_REQUIRED', last_error_message = 'm' WHERE id = ?").bind(item.id).run();
    expect(await checkItem(E, config, (await itemById(item.id))!)).toBeNull();
    expect(await itemById(item.id)).toMatchObject({ status: "good", last_error: null, last_error_message: null });
  });

  it("keeps a sync error on a healthy-looking bank (sync clears it once it works)", async () => {
    const item = await addItem();
    await env.DB.prepare("UPDATE items SET last_error = 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' WHERE id = ?").bind(item.id).run();
    await checkItem(E, config, (await itemById(item.id))!);
    expect((await itemById(item.id)).last_error).toBe("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
  });

  it("catches a broken connection before a sync fails", async () => {
    const item = await addItem();
    plaid.replies["/item/get"] = itemGet({ error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed", display_message: null } });
    expect(await checkItem(E, config, item)).toBe("ITEM_LOGIN_REQUIRED");
    expect(await itemById(item.id)).toMatchObject({ status: "login_required", last_error: "ITEM_LOGIN_REQUIRED",
      last_error_message: "the login details of this item have changed" });
  });

  it("records a transient error Plaid reports without changing the status", async () => {
    const item = await addItem();
    plaid.replies["/item/get"] = itemGet({ error: { error_code: "INSTITUTION_DOWN", error_message: "this institution is not currently responding" } });
    expect(await checkItem(E, config, item)).toBe("INSTITUTION_DOWN");
    expect(await itemById(item.id)).toMatchObject({ status: "good", last_error: "INSTITUTION_DOWN" });
  });

  it("marks a bank Plaid no longer knows as error, and retries a transient failure next run", async () => {
    const gone = await addItem();
    plaid.replies["/item/get"] = plaidError("ITEM_NOT_FOUND");
    expect(await checkItem(E, config, gone)).toBe("ITEM_NOT_FOUND");
    expect(await itemById(gone.id)).toMatchObject({ status: "error", last_error: "ITEM_NOT_FOUND" });
    const flaky = await addItem();
    plaid.replies["/item/get"] = plaidError("INTERNAL_SERVER_ERROR", 500, "API_ERROR");
    expect(await checkItem(E, config, flaky)).toBe("retry");
    expect(await itemById(flaky.id)).toMatchObject({ status: "good", checked_at: null, last_error: null });
  });

  it("skips banks it can't check", async () => {
    expect(await checkItem(E, config, await addItem({ owner: "alex", plaid_account: "alex_primary" }))).toBe("skipped");
    expect(await checkItem(E, config, await addItem({ token: await fernetEncrypt("x", "dGhpcy1pcy1hbm90aGVyLXRlc3Qta2V5LTMyYnl0ZXM=") }))).toBe("skipped");
    expect(plaid.calls).toEqual([]);
  });

  it("checks one bank per run, least recently checked first, each about once a day", async () => {
    const recent = await addItem();
    const old = await addItem();
    const never = await addItem();
    await addItem({ status: "error" });
    await env.DB.prepare("UPDATE items SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours') WHERE id = ?").bind(recent.id).run();
    await env.DB.prepare("UPDATE items SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 hours') WHERE id = ?").bind(old.id).run();
    expect(await checkConnections(E)).toEqual({ [never.id]: null });
    expect(await checkConnections(E)).toEqual({ [old.id]: null });
    expect(await checkConnections(E)).toEqual({});                   // recent was checked an hour ago
    expect(plaid.calls).toHaveLength(2);
  });

  it("doesn't run from the catch-up trigger", async () => {
    await addItem({ cursor: "k1" });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: CATCH_UP_CRON }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(plaid.calls).toEqual([]);
  });
});
