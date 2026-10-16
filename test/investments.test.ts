import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { fernetEncrypt } from "../src/fernet";
import { bankHealth } from "../src/health";
import { loadConfig } from "../src/config";
import { runSyncAll } from "../src/sync";
import { IN_RETIREMENT, runInvestmentSync, saveTxnPage, statusForInvestmentError } from "../src/investments";
import { call, getJson } from "./helpers";
import { FakePlaid, account, page, plaidError, txn } from "./fake-plaid";

// EGG, phase E1 (docs/cfa.md §3): retirement and brokerage accounts from Plaid Investments.
// Linking one (a new login, or Investments added to a bank already linked), the cron's fetch,
// islanding them from the dashboard, and their health. Plaid is never called: FakePlaid answers.
const E = env as unknown as Env;
const db = env.DB;
let plaid: FakePlaid;

const post = async (path: string, body: unknown) => {
  const r = await call(path, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const item = (id: number) => db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<any>();
const invSync = (id: number) => db.prepare("SELECT * FROM investment_sync WHERE item_id = ?").bind(id).first<any>();

const HOLDINGS = {
  accounts: [
    { account_id: "acc-401k", name: "Workplace 401(k)", mask: "1111", type: "investment", subtype: "401k", balances: { current: 84210.5, available: null, iso_currency_code: "USD" } },
    { account_id: "acc-roth", name: "Roth IRA", mask: "2222", type: "investment", subtype: "roth", balances: { current: 31000, available: null, iso_currency_code: "USD" } },
    { account_id: "acc-brk", name: "Brokerage", mask: "3333", type: "investment", subtype: "brokerage", balances: { current: 5000, available: 120, iso_currency_code: "USD" } },
  ],
  holdings: [
    { account_id: "acc-401k", security_id: "sec-vti", quantity: 250.5, institution_value: 70000, institution_price: 279.44, cost_basis: 52000 },
    { account_id: "acc-401k", security_id: "sec-cash", quantity: 14210.5, institution_value: 14210.5, institution_price: 1, cost_basis: 14210.5 },
    { account_id: "acc-roth", security_id: "sec-bnd", quantity: 400, institution_value: 31000, institution_price: 77.5, cost_basis: null },
  ],
  securities: [
    { security_id: "sec-vti", name: "Vanguard Total Stock Market ETF", ticker_symbol: "VTI", type: "etf", is_cash_equivalent: false, close_price: 279.44, close_price_as_of: "2026-10-15" },
    { security_id: "sec-bnd", name: "Vanguard Total Bond Market ETF", ticker_symbol: "BND", type: "etf", is_cash_equivalent: false, close_price: 77.5 },
    { security_id: "sec-cash", name: "Cash", ticker_symbol: "CUR:USD", type: "cash", is_cash_equivalent: true, close_price: 1 },
  ],
  item: { item_id: "plaid-item-1" }, request_id: "req-h",
};
const invTxn = (id: string, extra: Record<string, unknown> = {}) => ({
  investment_transaction_id: id, account_id: "acc-401k", security_id: null, date: "2026-09-15", name: "Employee contribution",
  quantity: 0, amount: -1000, price: 0, fees: 0, type: "cash", subtype: "contribution", iso_currency_code: "USD", ...extra,
});
const txns = (list: unknown[], total = list.length) => ({ body: { investment_transactions: list, total_investment_transactions: total, accounts: [], securities: [], request_id: "req-t" } });

async function addItem(o: { products?: string; status?: string } = {}) {
  const enc = await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
  return (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status, products, txn_cursor)
    VALUES ('me', 'me_primary', ?, ?, 'Schwab', ?, ?, NULL) RETURNING id`)
    .bind(`item-${crypto.randomUUID()}`, enc, o.status ?? "good", o.products ?? "investments").first<{ id: number }>())!.id;
}
async function catchUp() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/10 * * * *" }), E, ctx);
  await waitOnExecutionContext(ctx);
}

beforeEach(async () => {
  await db.batch(["investment_txns", "holdings", "securities", "investment_sync", "transaction_tags", "transactions", "accounts", "items", "link_sessions"]
    .map((t) => db.prepare(`DELETE FROM ${t}`)));
  plaid = new FakePlaid().install();
  plaid.replies["/investments/holdings/get"] = { body: HOLDINGS };
  plaid.replies["/investments/transactions/get"] = txns([invTxn("t1"), invTxn("t2", { date: "2026-08-15" }), invTxn("fee1", { type: "fee", subtype: "management fee", amount: 12.5 })]);
});
afterEach(() => vi.restoreAllMocks());

describe("linking a retirement account (a new Investments-only login)", () => {
  it("asks Plaid for investments only, stores an Investments-only bank, and leaves the first fetch to the cron", async () => {
    const t = await post("/link/token", { owner: "me", kind: "investments" });
    expect(t.status).toBe(200);
    expect(plaid.calls.at(-1)!.body.products).toEqual(["investments"]);
    expect(plaid.calls.at(-1)!.body.transactions).toBeUndefined();
    const x = await post("/link/exchange", { session_id: t.body.session_id, public_token: "public-sandbox-1", institution_name: "Charles Schwab" });
    expect(x.status).toBe(200);
    expect(await item(x.body.item_id)).toMatchObject({ products: "investments", institution_name: "Charles Schwab" });
    expect(await invSync(x.body.item_id)).toMatchObject({ status: "pending" });
    expect(plaid.paths()).not.toContain("/transactions/sync");       // no first transaction sync
  });

  it("a plain link is as before: transactions, and no investments", async () => {
    const t = await post("/link/token", { owner: "me" });
    expect(plaid.calls.at(-1)!.body.products).toEqual(["transactions"]);
    plaid.syncPages.push(page("c1", false));
    const x = await post("/link/exchange", { session_id: t.body.session_id, public_token: "public-sandbox-1" });
    expect(await item(x.body.item_id)).toMatchObject({ products: "transactions" });
    expect(await invSync(x.body.item_id)).toBeNull();
    expect((await post("/link/token", { owner: "me", kind: "stocks" })).status).toBe(422);
  });

  it("counts against the Trial cap like any bank", async () => {
    await db.batch(Array.from({ length: 10 }, (_, i) => db.prepare("INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc) VALUES ('me', 'me_primary', ?, 'x')").bind(`full-${i}`)));
    const t = await post("/link/token", { owner: "me", kind: "investments" });
    expect(t.status).toBe(200);
    expect(t.body.plaid_account).toBe("me_backup");
  });
});

describe("adding Investments to a bank already linked (update mode)", () => {
  it("asks for the extra consent, and turns it on only once Plaid's /item/get lists investments", async () => {
    const id = await addItem({ products: "transactions" });
    const t = await post("/link/token/investments", { item_id: id });
    expect(t.status).toBe(200);
    expect(plaid.calls.at(-1)!.body).toMatchObject({ access_token: "access-sandbox-secret", additional_consented_products: ["investments"] });
    expect((await post("/link/investments/complete", { session_id: t.body.session_id })).status).toBe(409);   // not consented yet
    plaid.replies["/item/get"] = { body: { item: { consented_products: ["transactions", "investments"], products: ["transactions"] } } };
    const done = await post("/link/investments/complete", { session_id: t.body.session_id });
    expect(done).toMatchObject({ status: 200, body: { item_id: id, investments: "pending" } });
    expect(await invSync(id)).toMatchObject({ status: "pending" });
    expect((await item(id)).products).toBe("transactions");          // still synced for its transactions
    expect((await post("/link/investments/complete", { session_id: t.body.session_id })).status).toBe(409);   // once
  });

  it("turning it off stops the fetch; what was saved stays", async () => {
    const id = await addItem({ products: "transactions" });
    await db.prepare("INSERT INTO investment_sync (item_id, status) VALUES (?, 'ready')").bind(id).run();
    expect((await post("/investments/off", { item_id: id })).body).toEqual({ item_id: id, investments: "off", changed: true });
    expect(await invSync(id)).toBeNull();
  });
});

describe("the cron's investments fetch", () => {
  it("a quiet catch-up run fetches one due bank: accounts, securities, holdings and investment transactions", async () => {
    const id = await addItem();
    await db.prepare("INSERT INTO investment_sync (item_id, status, next_attempt_at) VALUES (?, 'pending', '2026-01-01T00:00:00.000Z')").bind(id).run();
    await catchUp();
    expect(plaid.paths()).toEqual(["/investments/holdings/get", "/investments/transactions/get"]);
    expect(plaid.calls[1].body).toMatchObject({ options: { count: 250, offset: 0 } });
    const accts = (await db.prepare("SELECT plaid_account_id, owner, type, subtype, balance_current_cents FROM accounts WHERE item_id = ? ORDER BY plaid_account_id").bind(id).all()).results;
    expect(accts).toEqual([
      { plaid_account_id: "acc-401k", owner: "me", type: "investment", subtype: "401k", balance_current_cents: 8421050 },
      { plaid_account_id: "acc-brk", owner: "me", type: "investment", subtype: "brokerage", balance_current_cents: 500000 },
      { plaid_account_id: "acc-roth", owner: "me", type: "investment", subtype: "roth", balance_current_cents: 3100000 },
    ]);
    const held = (await db.prepare("SELECT h.security_id, h.value_cents, h.cost_basis_cents, s.ticker, s.type FROM holdings h JOIN securities s USING (security_id) ORDER BY h.security_id").all()).results;
    expect(held).toEqual([
      { security_id: "sec-bnd", value_cents: 3100000, cost_basis_cents: null, ticker: "BND", type: "etf" },
      { security_id: "sec-cash", value_cents: 1421050, cost_basis_cents: 1421050, ticker: "CUR:USD", type: "cash" },
      { security_id: "sec-vti", value_cents: 7000000, cost_basis_cents: 5200000, ticker: "VTI", type: "etf" },
    ]);
    expect((await db.prepare("SELECT count(*) AS n, sum(amount_cents) AS s FROM investment_txns").first<any>())).toEqual({ n: 3, s: -198750 });
    expect(await invSync(id)).toMatchObject({ status: "ready", txn_offset: 0, last_error: null });
    expect((await invSync(id)).txn_start).toBe(new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));   // the next window overlaps 30 days
  });

  it("pages through a long history over several runs; holdings only on the first page", async () => {
    const id = await addItem();
    await db.prepare("INSERT INTO investment_sync (item_id, status, next_attempt_at) VALUES (?, 'pending', '2026-01-01T00:00:00.000Z')").bind(id).run();
    plaid.replies["/investments/transactions/get"] = txns([invTxn("a")], 300);
    const config = loadConfig(E);
    await runInvestmentSync(E, config);
    expect((await invSync(id)).last_error).toBe(null);
    expect(await invSync(id)).toMatchObject({ txn_offset: 250, txn_start: null });
    plaid.calls = [];
    plaid.replies["/investments/transactions/get"] = txns([invTxn("b")], 300);
    await runInvestmentSync(E, config);
    expect(plaid.paths()).toEqual(["/investments/transactions/get"]);
    expect(plaid.calls[0].body.options).toEqual({ count: 250, offset: 250 });
    expect(await invSync(id)).toMatchObject({ txn_offset: 0, status: "ready" });
    expect(await saveTxnPage(E, id, 0, JSON.stringify({ investment_transactions: [], total_investment_transactions: 0 }))).toBe(false);
  });

  it("a failure is recorded on investment_sync only, never on the bank's sync status", async () => {
    const id = await addItem({ products: "transactions" });
    await db.prepare("INSERT INTO investment_sync (item_id, status, next_attempt_at) VALUES (?, 'ready', '2026-01-01T00:00:00.000Z')").bind(id).run();
    plaid.replies["/investments/holdings/get"] = plaidError("PRODUCT_NOT_READY");
    await runInvestmentSync(E);
    expect(await invSync(id)).toMatchObject({ status: "pending", last_error: "PRODUCT_NOT_READY" });
    expect(await item(id)).toMatchObject({ status: "good", last_error: null });
    expect(statusForInvestmentError("ITEM_LOGIN_REQUIRED")).toBe("consent_required");
    expect(statusForInvestmentError("NO_INVESTMENT_ACCOUNTS")).toBe("unsupported");
    expect(statusForInvestmentError("INTERNAL_SERVER_ERROR")).toBe("error");
  });

  it("the transaction sync skips Investments-only banks", async () => {
    await addItem();
    expect(await runSyncAll(E)).toEqual({});
    expect(plaid.paths()).toEqual([]);
  });
});

describe("islanding: retirement accounts show in EGG, not on the dashboard", () => {
  async function seed() {
    const id = await addItem({ products: "transactions" });
    const ins = db.prepare("INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, ?, ?, ?, ?) RETURNING id");
    const ids: Record<string, number> = {};
    for (const [key, type, subtype] of [["checking", "depository", "checking"], ["hsa", "depository", "hsa"], ["ira", "investment", "ira"], ["brokerage", "investment", "brokerage"]]) {
      ids[key] = (await ins.bind(id, key, key, type, subtype).first<{ id: number }>())!.id;
    }
    const t = db.prepare("INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name) VALUES ('me', ?, ?, 100, '2026-09-01', ?)");
    await db.batch([t.bind(ids.checking, "t-chk", "Coffee"), t.bind(ids.hsa, "t-hsa", "Pharmacy")]);
    return ids;
  }

  it("/accounts and /transactions leave out retirement accounts (an HSA too); ?view=all lists every account", async () => {
    const ids = await seed();
    expect((await getJson<any[]>("/accounts")).body.map((a) => a.name).sort()).toEqual(["brokerage", "checking"]);
    expect((await getJson<any[]>("/accounts?view=all")).body.map((a) => [a.name, a.in_retirement]).sort())
      .toEqual([["brokerage", 0], ["checking", 0], ["hsa", 1], ["ira", 1]]);
    expect((await getJson<any[]>("/transactions")).body.map((t) => t.name)).toEqual(["Coffee"]);
    // switched back to the dashboard, the HSA and its transactions show again
    expect((await getJson<any>(`/accounts/${ids.hsa}/view`, { method: "PUT", body: JSON.stringify({ view: "dashboard" }) })).body)
      .toEqual({ id: ids.hsa, view: "dashboard", in_retirement: false });
    expect((await getJson<any[]>("/transactions")).body.map((t) => t.name).sort()).toEqual(["Coffee", "Pharmacy"]);
    // and a brokerage can be moved into EGG
    await getJson(`/accounts/${ids.brokerage}/view`, { method: "PUT", body: JSON.stringify({ view: "retirement" }) });
    expect((await getJson<any[]>("/accounts")).body.map((a) => a.name).sort()).toEqual(["checking", "hsa"]);
    expect((await getJson(`/accounts/${ids.ira}/view`, { method: "PUT", body: JSON.stringify({ view: "sideways" }) })).status).toBe(422);
    expect((await getJson("/accounts/999999/view", { method: "PUT", body: JSON.stringify({ view: null }) })).status).toBe(404);
  });

  it("the retirement subtypes, case-insensitively", async () => {
    const q = (subtype: string, view: string | null = null) =>
      db.prepare(`SELECT ${IN_RETIREMENT("a")} AS r FROM (SELECT ? AS subtype, ? AS view) a`).bind(subtype, view).first<{ r: number }>().then((x) => x!.r);
    for (const s of ["401k", "403B", "roth", "Roth 401k", "sep ira", "hsa", "pension"]) expect(await q(s), s).toBe(1);
    for (const s of ["brokerage", "checking", "savings", "credit card", "529"]) expect(await q(s), s).toBe(0);
    expect(await q("401k", "dashboard")).toBe(0);
    expect(await q("brokerage", "retirement")).toBe(1);
  });
});

describe("health of an Investments-only bank", () => {
  const row = (o: Record<string, unknown>) => ({ id: 1, owner: "me", plaid_account: "me_primary", institution_name: "Schwab", status: "good",
    updated_at: "2026-01-01T00:00:00.000Z", last_error: null, last_error_message: null, downloading: 0, synced_once: 0, consent_expires_at: null, txns: 0,
    products: "investments", inv_status: "ready", inv_synced_at: new Date().toISOString(), inv_error: null, ...o });
  const config = () => loadConfig(E);

  it("isn't 'stalled' for lack of a transaction sync; its verdict comes from the investments fetch", () => {
    expect(bankHealth(E, config(), row({})).state).toBe("ok");
    expect(bankHealth(E, config(), row({ inv_status: "pending", inv_synced_at: null }))).toMatchObject({ state: "downloading", level: "info" });
    expect(bankHealth(E, config(), row({ inv_status: "consent_required", inv_error: "ITEM_LOGIN_REQUIRED" }))).toMatchObject({ state: "reconnect", action: "reconnect" });
    expect(bankHealth(E, config(), row({ inv_status: "unsupported", inv_error: "NO_INVESTMENT_ACCOUNTS" }))).toMatchObject({ state: "broken", level: "warn", detail: "Plaid sees no investment accounts on this login." });
    expect(bankHealth(E, config(), row({ inv_synced_at: new Date(Date.now() - 72 * 3.6e6).toISOString() }))).toMatchObject({ state: "stalled" });
    expect(bankHealth(E, config(), row({ status: "login_required" }))).toMatchObject({ state: "reconnect" });
  });

  it("GET /investments lists every bank with its Investments status and retirement accounts", async () => {
    const id = await addItem();
    await db.prepare("INSERT INTO investment_sync (item_id, status) VALUES (?, 'ready')").bind(id).run();
    await db.prepare("INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype) VALUES ('me', ?, 'x', 'IRA', 'investment', 'ira')").bind(id).run();
    expect((await getJson<any[]>("/investments")).body).toEqual([expect.objectContaining({ item_id: id, bank: "Schwab", products: "investments", investments: "ready", retirement_accounts: 1, investment_accounts: 1 })]);
  });
});
