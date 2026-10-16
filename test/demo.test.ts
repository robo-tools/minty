import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { demoEnv, generate, statements } from "../demo/data";
import { getJson } from "./helpers";

// The live demo's made-up household (demo/data.ts), loaded into the real local D1 and read back
// through the real routes with the demo's own settings (its people and placeholder keys), as the
// demo does in the browser.

const data = generate(new Date());
const envOverrides = demoEnv(data) as any;

beforeAll(async () => {
  const db = env.DB;
  await db.batch(["investment_txns", "holdings", "securities", "investment_sync", "balance_snapshots", "recurring_charges", "net_worth", "monthly_totals", "point_balances", "card_statements", "benefit_marks", "card_products", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.batch(statements(data).map(([sql, params]) => db.prepare(sql).bind(...params)));
});

describe("demo data", () => {
  it("is made up: no emails, account or phone numbers, or other people's names", () => {
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\d{3}[-. ]\d{3}[-. ]\d{4}/);                    // phone numbers
    for (const a of data.accounts) expect(String(a.mask)).toMatch(/^\d{4}$/);
    const names = data.transactions.map((t) => `${t.name} ${t.merchant_name ?? ""}`).join("\n");
    expect(names).not.toMatch(/\d{5,}/);                                       // no long numbers in descriptions
    expect(new Set(data.transactions.map((t) => t.account_owner).filter(Boolean))).toEqual(new Set(["ALEX MORGAN", "SAM MORGAN"]));
    expect(data.users).toBe("alex:Alex,sam:Sam,kate:Kate,adam:Adam,andy:Andy,maurice:Maurice");
  });

  it("stays small (at most 500 transactions), so the demo starts fast", () => {
    expect(data.transactions.length).toBeGreaterThan(400);
    expect(data.transactions.length).toBeLessThanOrEqual(500);
  });

  it("gives Kate, Adam, Andy and Maurice one transaction each", () => {
    const first = (owner: string) => data.transactions.filter((t) => t.owner === owner).map((t) => t.name);
    expect(first("kate")).toEqual(["WM Money Center"]);
    expect(first("adam")).toEqual(["PPK Call"]);
    expect(first("andy")).toEqual(["HBFC Supplements"]);
    expect(first("maurice")).toEqual(["Bluz Cards Emes"]);
  });

  it("is the same for the same day", () => {
    const again = generate(new Date());
    expect(JSON.stringify(again.transactions.map((t) => [t.date, t.amount_cents, t.name]))).toBe(
      JSON.stringify(data.transactions.map((t) => [t.date, t.amount_cents, t.name])));
  });

  it("never has a transaction after today", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(data.transactions.every((t) => String(t.date) <= today)).toBe(true);
  });
});

describe("demo data through the real routes", () => {
  it("lists the transactions and one bank whose access is about to end", async () => {
    const tx = await getJson<unknown[]>("/transactions", { envOverrides });
    expect(tx.status).toBe(200);
    expect(tx.body.length).toBeGreaterThan(100);
    const health = await getJson<{ sync: { ok: boolean }; banks: { institution_name: string; health: { state: string } }[] }>("/health", { envOverrides });
    expect(health.status).toBe(200);
    expect(health.body.sync.ok).toBe(true);
    const states = health.body.banks.map((b) => `${b.institution_name}:${b.health.state}`);
    expect(states).toContain("Ally Bank:expiring");
    expect(states.filter((s) => !s.endsWith(":ok") && !s.startsWith("Ally Bank:"))).toEqual([]);
  });

  it("gives ABC used, open and tick-box credits on all three tracked cards", async () => {
    const { status, body } = await getJson<any>("/benefits", { envOverrides });
    expect(status).toBe(200);
    const byProduct = new Map(body.cards.filter((c: any) => c.product).map((c: any) => [c.product.id, c]));
    expect([...byProduct.keys()].sort()).toEqual(["amex_business_gold", "amex_platinum", "citi_strata_premier"]);
    const platinum: any = byProduct.get("amex_platinum");
    const statuses = new Set(platinum.benefits.flatMap((b: any) => b.periods.map((p: any) => p.status)));
    expect(statuses).toContain("used");
    expect([...statuses].some((s) => s === "open" || s === "partial")).toBe(true);
    expect(platinum.benefits.find((b: any) => b.id === "uber_cash").how).toBe("outside");
    expect(body.totals.used_cents).toBeGreaterThan(0);
  });
});

describe("demo CFA", () => {
  it("the audit has made-up totals, recurring charges and a net worth history once the cron step runs", async () => {
    const { refreshTotals, snapshotBalances } = await import("../src/audit/totals");
    const E = { ...(env as any), ...envOverrides };
    await snapshotBalances(E);
    await refreshTotals(E);
    const { status, body } = await getJson<any>("/audit", { envOverrides });
    expect(status).toBe(200);
    expect(body.totals.some((t: any) => t.bucket === "income" && t.cents < 0)).toBe(true);
    expect(body.totals.some((t: any) => t.bucket === "saving" && t.cents === 150000)).toBe(true);     // the transfer to savings
    expect(body.recurring.map((r: any) => r.name)).toEqual(expect.arrayContaining(["Netflix", "Spotify", "Maple Court Apartments Rent"]));
    expect(body.net_worth.length).toBeGreaterThan(100);
  });
});

describe("demo CFA advice", () => {
  it("made-up findings and the checklist, once the cron step ran", async () => {
    const { refreshTotals, snapshotBalances } = await import("../src/audit/totals");
    const E = { ...(env as any), ...envOverrides };
    await snapshotBalances(E);
    await refreshTotals(E);
    const { status, body } = await getJson<any>("/audit/advice", { envOverrides });
    expect(status).toBe(200);
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.checklist.length).toBeGreaterThan(5);
  });
});

describe("demo EGG", () => {
  it("made-up retirement accounts, islanded from the dashboard, with contributions, holdings and history", async () => {
    const { status, body } = await getJson<any>("/retirement", { envOverrides });
    expect(status).toBe(200);
    expect(body.accounts.filter((a: any) => a.in_retirement).map((a: any) => a.subtype).sort()).toEqual(["401k", "hsa", "ira", "roth"]);
    expect(body.contributions.some((c: any) => c.kind === "workplace" && c.cents > 0)).toBe(true);
    expect(body.mix.map((m: any) => m.class).sort()).toEqual(["blend", "bonds", "cash", "stocks"]);
    expect(body.snapshots.length).toBeGreaterThan(500);
    const dash = (await getJson<any[]>("/accounts", { envOverrides })).body;
    expect(dash.some((a: any) => a.subtype === "401k")).toBe(false);
  });
});

describe("demo BAM", () => {
  it("shows made-up balances by currency, with history and one not updated in months", async () => {
    const { status, body } = await getJson<any>("/points", { envOverrides });
    expect(status).toBe(200);
    const amex = body.balances.find((b: any) => b.program === "amex_mr");
    expect(amex).toMatchObject({ name: "Amex Membership Rewards", balance: 84210, kind: "bank" });
    expect(amex.history.map((h: any) => h.balance)).toEqual([72480, 61250]);
    expect(body.balances.filter((b: any) => b.program === "chase_ur")).toHaveLength(2);       // both people
    const marriott = body.balances.find((b: any) => b.program === "marriott");
    expect(Date.parse(body.today) - Date.parse(marriott.as_of)).toBeGreaterThan(90 * 864e5);
  });
});
