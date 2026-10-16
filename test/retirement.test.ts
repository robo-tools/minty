import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";
import { LIMITS, kindOf } from "../src/retirement/limits";

// EGG, phase E2 (docs/cfa.md §3): GET /retirement reads what's stored; PUT /retirement/profile
// keeps each person's optional profile.
const db = env.DB;
const year = new Date().getUTCFullYear();
const send = (method: string, path: string, body?: unknown) => getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
let ids: Record<string, number>;

beforeEach(async () => {
  await db.batch(["investment_txns", "holdings", "securities", "investment_sync", "balance_snapshots", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'retirement_profile:%'").run();
  const item = (await db.prepare(`INSERT INTO items (owner, plaid_account, plaid_item_id, access_token_enc, institution_name, status, products)
    VALUES ('me', 'me_primary', 'i-ret', 'x', 'Schwab', 'good', 'investments') RETURNING id`).first<{ id: number }>())!.id;
  ids = {};
  const ins = db.prepare("INSERT INTO accounts (owner, item_id, plaid_account_id, name, type, subtype, balance_current_cents) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id");
  for (const [k, owner, type, subtype, bal] of [["k401", "me", "investment", "401k", 10000000], ["roth", "me", "investment", "roth", 3000000],
    ["brk", "me", "investment", "brokerage", 500000], ["hsa", "spouse", "depository", "hsa", 400000], ["chk", "me", "depository", "checking", 100000]] as const) {
    ids[k] = (await ins.bind(owner, item, k, k, type, subtype, bal).first<{ id: number }>())!.id;
  }
  const it = db.prepare(`INSERT INTO investment_txns (account_id, plaid_inv_txn_id, date, name, type, subtype, amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  await db.batch([
    it.bind(ids.k401, "c1", `${year}-02-15`, "Contribution", "cash", "contribution", -150000),
    it.bind(ids.k401, "c2", `${year}-03-15`, "Contribution", "cash", "contribution", -150000),
    it.bind(ids.k401, "r1", `${year}-03-20`, "Rollover in", "transfer", "transfer", -900000),          // not a contribution
    it.bind(ids.roth, "c3", `${year}-01-10`, "Deposit", "cash", "deposit", -700000),
    it.bind(ids.k401, "f1", `${year}-04-01`, "Fee", "fee", "account fee", 2500),
    it.bind(ids.k401, "d1", `${year}-04-02`, "Dividend", "cash", "dividend", -9000),                    // not a contribution
  ]);
  const t = db.prepare("INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name, category) VALUES ('spouse', ?, ?, ?, ?, ?, ?)");
  await db.batch([t.bind(ids.hsa, "h1", -30000, `${year}-02-01`, "Employer HSA contribution", "TRANSFER_IN"), t.bind(ids.hsa, "h2", -120, `${year}-02-28`, "Interest", "INCOME"),
                  t.bind(ids.hsa, "h3", 4500, `${year}-03-03`, "Pharmacy", "MEDICAL")]);
  await db.prepare("INSERT INTO securities (security_id, name, type, is_cash_equivalent) VALUES ('s-500', 'Total Market Index', 'mutual fund', 0), ('s-bond', 'Total Bond Index', 'etf', 0), ('s-cash', 'Cash', 'cash', 1)").run();
  await db.prepare(`INSERT INTO holdings (account_id, security_id, value_cents) VALUES (?1, 's-500', 7000000), (?1, 's-bond', 2000000), (?1, 's-cash', 1000000), (?2, 's-500', 400000)`).bind(ids.k401, ids.brk).run();
  await db.prepare("INSERT INTO balance_snapshots (account_id, date, current_cents) VALUES (?1, '2026-09-01', 9500000), (?1, '2026-10-01', 10000000), (?2, '2026-10-01', 500000)").bind(ids.k401, ids.brk).run();
});

describe("GET /retirement", () => {
  it("is behind Access like every API route", async () => {
    expect((await call("/retirement", { token: null })).status).toBe(403);
  });

  it("the retirement accounts and the other investment accounts, contributions (not rollovers or dividends), fees, the mix, the limits", async () => {
    const { body } = await getJson<any>("/retirement");
    expect(body.accounts.map((a: any) => [a.name, a.in_retirement, a.kind]).sort()).toEqual([["brk", false, null], ["hsa", true, "hsa"], ["k401", true, "workplace"], ["roth", true, "ira"]]);
    const c = Object.fromEntries(body.contributions.filter((x: any) => x.year === String(year)).map((x: any) => [x.subtype, x.cents]));
    expect(c).toEqual({ "401k": 300000, roth: 700000, hsa: 30000 });                                  // the HSA's interest and spending don't count
    expect(body.fees).toEqual([{ owner: "me", cents: 2500 }]);
    expect(Object.fromEntries(body.mix.map((m: any) => [m.class, m.cents]))).toEqual({ stocks: 7000000, bonds: 2000000, cash: 1000000 });   // the brokerage's holdings aren't in it
    expect(body.snapshots).toEqual(expect.arrayContaining([{ account_id: ids.k401, date: "2026-10-01", cents: 10000000 }]));
    expect(body.snapshots.some((s: any) => s.account_id === ids.brk)).toBe(false);
    expect(body.limits?.year ?? year).toBe(year);
  });

  it("one person", async () => {
    const { body } = await getJson<any>("/retirement?owner=spouse");
    expect(body.accounts.map((a: any) => a.name)).toEqual(["hsa"]);
    expect(body.contributions.map((c: any) => c.subtype)).toEqual(["hsa"]);
    expect((await getJson("/retirement?owner=nobody")).status).toBe(422);
  });

  it("moving the brokerage into EGG brings its holdings and history in", async () => {
    await send("PUT", `/accounts/${ids.brk}/view`, { view: "retirement" });
    const { body } = await getJson<any>("/retirement");
    expect(body.accounts.find((a: any) => a.name === "brk").in_retirement).toBe(true);
    expect(body.mix.find((m: any) => m.class === "stocks").cents).toBe(7400000);
  });
});

describe("PUT /retirement/profile", () => {
  it("saves each person's profile, every field optional", async () => {
    expect((await send("PUT", "/retirement/profile", { owner: "me", birth_year: 1988, retire_age: 62, target_cents: 150000000, match_pct: 4, hsa_coverage: "family" })).status).toBe(200);
    await send("PUT", "/retirement/profile", { owner: "spouse" });
    const { body } = await getJson<any>("/retirement");
    expect(body.profiles).toEqual({ me: { birth_year: 1988, retire_age: 62, target_cents: 150000000, match_pct: 4, hsa_coverage: "family" }, spouse: {} });
  });

  it.each([[{ birth_year: 1800 }], [{ retire_age: 30 }], [{ match_pct: 40 }], [{ hsa_coverage: "couple" }], [{ beneficiaries_checked_on: "today" }], [{ owner: "nobody" }], [{ target_cents: -1 }]])(
    "refuses %j", async (b) => {
      expect((await send("PUT", "/retirement/profile", { owner: "me", ...b })).status).toBe(422);
    });
});

describe("the limits", () => {
  it("this year's are in the code, with sources; each account type maps to its limit", () => {
    expect(LIMITS[2026]).toMatchObject({ workplace: 2450000, workplaceCatchUp50: 800000, workplaceCatchUp60to63: 1125000, ira: 750000, iraCatchUp50: 110000, hsaSelf: 440000, hsaFamily: 875000, hsaCatchUp55: 100000 });
    expect(LIMITS[2026].sources.every((u) => u.startsWith("https://www.irs.gov/"))).toBe(true);
    expect(["401k", "403b", "457b", "Roth 401k", "ira", "roth", "simple ira", "hsa", "sep ira", "brokerage"].map(kindOf))
      .toEqual(["workplace", "workplace", "workplace", "workplace", "ira", "ira", "simple", "hsa", null, null]);
  });
});
