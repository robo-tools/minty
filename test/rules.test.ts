import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { checklist, fullMonths, recommend, type AdviceInput, type Month } from "../src/audit/rules";
import { LIMITS } from "../src/retirement/limits";
import { call, getJson } from "./helpers";

// CFA, phase C3 (docs/cfa.md §2.3): the audit's recommendations as rules, and the planner's checklist.
const TODAY = "2026-10-16";
const ym = (back: number) => new Date(Date.UTC(2026, 9 - back, 1)).toISOString().slice(0, 7);
const month = (back: number, o: Partial<Month> = {}): Month => ({ month: ym(back), income: 600000, spend: 400000, saving: 0, debt: 0, cats: { FOOD_AND_DRINK: 100000, RENT_AND_UTILITIES: 300000 }, n: 80, ...o });
const months = (f: (back: number) => Partial<Month> = () => ({})) => Array.from({ length: 13 }, (_, i) => month(12 - i, f(12 - i)));
const base = (o: Partial<AdviceInput> = {}): AdviceInput => ({
  today: TODAY, months: months(), recurring: [], checkingCents: 500000, savingsCents: 2000000,
  retirement: { accounts: [{ owner: "me", subtype: "401k", in_retirement: true, balance: 10000000 }], contributions: [], profiles: {}, mix: [], limits: LIMITS[2026] },
  holdings: [], hasBrokerage: false, people: ["me"], labels: { me: "Me" }, checklist: {}, ...o,
});
const ids = (x: AdviceInput) => recommend(x).map((f) => f.id);
const find = (x: AdviceInput, id: string) => recommend(x).find((f) => f.id === id);

describe("the months judged by", () => {
  it("whole months only, from the first busy one (an annual fee alone a year ago doesn't count)", () => {
    const ms = months((b) => (b >= 10 ? { n: 1, income: 0, spend: 69500, cats: { BANK_FEES: 69500 } } : {}));
    const f = fullMonths(ms, TODAY);
    expect(f[0].month).toBe(ym(9));
    expect(f.at(-1)!.month).toBe(ym(1));                                     // not the current, partial month
  });
});

describe("saving", () => {
  it("a savings rate under 15%: the monthly gap to 15%, in dollars a year", () => {
    const f = find(base({ months: months(() => ({ income: 500000, spend: 470000 })) }), "savings_rate")!;
    expect(f).toMatchObject({ level: "consider", yearly_cents: Math.round((0.15 * 500000 - 30000) * 12) });
    expect(f.title).toBe("You keep 6% of what comes in");
    expect(find(base({ months: months(() => ({ income: 500000, spend: 490000 })) }), "savings_rate")!.level).toBe("act");   // under 5%
  });

  it("20% or more is said as good news", () => {
    expect(find(base(), "savings_rate")).toMatchObject({ level: "good", title: "You keep 33% of what comes in" });
  });

  it("an emergency fund under 3 months of spending; above it, idle cash in checking", () => {
    expect(find(base({ checkingCents: 300000, savingsCents: 200000 }), "emergency_fund")).toMatchObject({ level: "act", title: "Cash covers 1.3 months of spending" });
    const idle = find(base({ checkingCents: 1500000, savingsCents: 0 }), "idle_cash")!;   // 3.75 months in checking alone
    expect(idle).toMatchObject({ level: "consider", yearly_cents: Math.round((1500000 - 800000) * 0.03) });
    expect(ids(base())).not.toContain("idle_cash");                         // $5,000 in checking: under 2 months
  });
});

describe("debt and fees", () => {
  it("card interest is a must-act, a year's worth; fees are worth a look", () => {
    const x = base({ months: months(() => ({ cats: { FOOD_AND_DRINK: 100000, RENT_AND_UTILITIES: 300000, INTEREST: 4200, BANK_FEES: 1000 } })) });
    expect(find(x, "card_interest")).toMatchObject({ level: "act", yearly_cents: 50400, title: "$504 a year in interest" });
    expect(find(x, "fees")).toMatchObject({ level: "consider", yearly_cents: 12000 });
    expect(recommend(x)[0].id).toBe("card_interest");                      // must-acts first
  });
});

describe("spending", () => {
  it("a category up 20% and $50 a month on its own average, after 6 months", () => {
    const x = base({ months: months((b) => (b <= 3 ? { cats: { FOOD_AND_DRINK: 180000, RENT_AND_UTILITIES: 300000 } } : {})) });
    const f = find(x, "rising_FOOD_AND_DRINK")!;
    expect(f.title).toMatch(/^Food & drink is up \d+% lately$/);
    expect(f.yearly_cents).toBeGreaterThan(0);
    expect(ids(base({ months: months((b) => (b <= 3 ? { cats: { FOOD_AND_DRINK: 104000, RENT_AND_UTILITIES: 300000 } } : {})) }))).not.toContain("rising_FOOD_AND_DRINK");   // under $50
  });

  const rec = (o: Record<string, unknown>) => ({ name: "Netflix", merchant: "NETFLIX", cadence: "monthly" as const, category: "ENTERTAINMENT", avg_cents: 1600, last_cents: 1799, prev_cents: 1549,
    distinct_amounts: 2, last_date: "2026-10-03", corrected: null, ...o });
  it("a fixed price that went up, a year of it; not for a varying bill, an ended one or one corrected to saving", () => {
    expect(find(base({ recurring: [rec({})] }), "price_NETFLIX")).toMatchObject({ yearly_cents: 250 * 12, title: "Netflix went up 16%" });
    expect(ids(base({ recurring: [rec({ distinct_amounts: 6 })] }))).not.toContain("price_NETFLIX");
    expect(ids(base({ recurring: [rec({ last_date: "2026-07-01" })] }))).not.toContain("price_NETFLIX");
    expect(ids(base({ recurring: [rec({ corrected: "saving" })] }))).not.toContain("price_NETFLIX");
  });

  it("three or more subscriptions worth $300+ a year get a yearly review; rent doesn't count", () => {
    const subs = ["A", "B", "C"].map((m) => rec({ merchant: m, name: m, last_cents: 1000, prev_cents: 1000, distinct_amounts: 1 }));
    expect(find(base({ recurring: subs }), "subscriptions")).toMatchObject({ title: "3 subscriptions and memberships, $360 a year" });
    expect(ids(base({ recurring: [...subs.slice(0, 2), rec({ merchant: "RENT", category: "RENT_AND_UTILITIES", last_cents: 300000, prev_cents: 300000, distinct_amounts: 1 })] }))).not.toContain("subscriptions");
  });
});

describe("retirement and investing", () => {
  it("no retirement accounts linked for a person", () => {
    expect(find(base({ retirement: { accounts: [], contributions: [], profiles: {}, mix: [], limits: LIMITS[2026] } }), "no_retirement")!.title).toBe("No retirement accounts linked");
    const two = base({ people: ["me", "sam"], labels: { me: "Me", sam: "Sam" } });
    expect(find(two, "no_retirement")!.title).toBe("No retirement accounts linked for Sam");
  });

  it("behind an even pace for this year's limit, with the catch-up by age; the match reminder", () => {
    const x = base({ retirement: { accounts: [{ owner: "me", subtype: "401k", in_retirement: true, balance: 1 }],
      contributions: [{ owner: "me", subtype: "401k", year: "2026", cents: 1000000 }], profiles: { me: { birth_year: 1970, match_pct: 4 } }, mix: [], limits: LIMITS[2026] } });
    const pace = find(x, "pace_workplace_me")!;
    expect(pace.title).toBe("401(k): $10,000 of the $32,500 limit this year");   // 56 years old: $24,500 + $8,000
    expect(pace.action).toMatch(/^About \$7,500 a month would reach the 2026 limit by December 31/);
    expect(find(x, "match_me")).toMatchObject({ level: "act" });
    const onPace = base({ retirement: { ...x.retirement, contributions: [{ owner: "me", subtype: "401k", year: "2026", cents: 2600000 }] } });
    expect(ids(onPace)).not.toContain("pace_workplace_me");
  });

  it("uses only confirmed current-year figures for each person's contribution pace", () => {
    const limits = { ...LIMITS[2026], year: 2027, workplace: 2500000,
      provisional: ["hsaSelf", "hsaFamily", "hsaCatchUp55", "workplaceCatchUp60to63"] as const };
    const x = base({ today: "2027-10-16", retirement: {
      ...base().retirement,
      accounts: ["401k", "ira", "hsa"].map((subtype) => ({ owner: "me", subtype, in_retirement: true, balance: 1 })),
      profiles: { me: { birth_year: 1970, match_pct: 4, hsa_coverage: "family" } },
      limits: { ...limits, provisional: [...limits.provisional] },
    } });
    expect(find(x, "pace_workplace_me")!.title).toContain("$33,000 limit"); // the age-50 catch-up is confirmed
    expect(ids(x)).toContain("pace_ira_me");
    expect(ids(x)).not.toContain("pace_hsa_me");

    x.retirement.profiles.me.birth_year = 1965;                         // age 62 uses the provisional catch-up
    expect(ids(x)).not.toContain("pace_workplace_me");
    expect(ids(x)).toEqual(expect.arrayContaining(["pace_ira_me", "match_me"]));

    x.retirement.limits = { ...limits, provisional: [] };               // publication confirms the same figures
    expect(ids(x)).toEqual(expect.arrayContaining(["pace_workplace_me", "pace_ira_me", "pace_hsa_me"]));
  });

  it("does not withhold a confirmed base limit for a catch-up that does not apply", () => {
    const x = base();
    x.retirement.profiles.me = { birth_year: 1990 };
    x.retirement.limits = { ...LIMITS[2026], year: 2026, provisional: ["workplaceCatchUp50", "workplaceCatchUp60to63"] };
    expect(find(x, "pace_workplace_me")!.title).toContain("$24,500 limit");
    x.retirement.profiles.me.birth_year = 1970;
    expect(ids(x)).not.toContain("pace_workplace_me");
  });

  it("withholds numerical pace advice for a different year or missing/invalid applicable limits", () => {
    const x = base();
    x.retirement.limits = { ...LIMITS[2026], year: 2025, provisional: [] };
    expect(ids(x)).not.toContain("pace_workplace_me");
    for (const workplace of [undefined, NaN, Infinity, -1, 0]) {
      x.retirement.limits = { ...LIMITS[2026], workplace, year: 2026, provisional: [] };
      expect(ids(x)).not.toContain("pace_workplace_me");
    }
    x.retirement.profiles.me = { birth_year: 1970 };
    for (const workplaceCatchUp50 of [undefined, NaN, Infinity, -1]) {
      x.retirement.limits = { ...LIMITS[2026], workplaceCatchUp50, year: 2026, provisional: [] };
      expect(ids(x)).not.toContain("pace_workplace_me");
    }
  });

  it("cash over 10% of the retirement accounts before 55; one stock over 10% of investments, never a fund", () => {
    expect(ids(base({ retirement: { accounts: base().retirement.accounts, contributions: [], profiles: {}, mix: [{ class: "stocks", cents: 800 }, { class: "cash", cents: 200 }], limits: LIMITS[2026] } }))).toContain("cash_drag");
    const holdings = [{ name: "Acme Corp", type: "equity", cents: 3000 }, { name: "Total Stock Market Index Fund", type: "mutual fund", cents: 7000 }];
    expect(ids(base({ holdings }))).toContain("concentration_Acme Corp");
    expect(ids(base({ holdings: [{ name: "S&P 500 ETF", type: "etf", cents: 9000 }, { name: "Acme Corp", type: "equity", cents: 500 }] }))).toEqual(expect.not.arrayContaining([expect.stringMatching(/^concentration/)]));
  });
});

describe("the planner's checklist", () => {
  it("every item is due until ticked, and again a year later; beneficiaries count from EGG's profile too", () => {
    let c = checklist(base());
    expect(c.every((i) => i.due)).toBe(true);
    expect(c.map((i) => i.id)).not.toContain("tax_loss");                    // no taxable investments
    expect(c.map((i) => i.id)).not.toContain("rmd");                         // nobody near 73
    c = checklist(base({ checklist: { will: "2026-01-02", umbrella: "2025-09-01" }, hasBrokerage: true,
      retirement: { ...base().retirement, profiles: { me: { birth_year: 1950, beneficiaries_checked_on: "2026-06-01" } } } }));
    const by = Object.fromEntries(c.map((i) => [i.id, i]));
    expect(by.will).toMatchObject({ due: false, checked_on: "2026-01-02" });
    expect(by.umbrella.due).toBe(true);                                      // over a year ago
    expect(by.beneficiaries).toMatchObject({ due: false, checked_on: "2026-06-01" });
    expect(by.tax_loss).toBeTruthy();
    expect(by.rmd).toBeTruthy();
  });
});

describe("the routes", () => {
  beforeEach(async () => {
    await env.DB.batch(["monthly_totals", "recurring_charges", "holdings", "investment_txns", "balance_snapshots", "transactions", "accounts", "items"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    await env.DB.prepare("DELETE FROM app_state WHERE key = 'audit_checklist'").run();
  });

  it("GET /audit/advice runs the rules on what's stored, behind Access", async () => {
    expect((await call("/audit/advice", { token: null })).status).toBe(403);
    const ins = env.DB.prepare("INSERT INTO monthly_totals (month, owner, bucket, category, amount_cents, n) VALUES (?, 'me', ?, ?, ?, 40)");
    const now = new Date(), m = (b: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - b, 1)).toISOString().slice(0, 7);
    await env.DB.batch([1, 2, 3, 4].flatMap((b) => [ins.bind(m(b), "income", "INCOME", -500000), ins.bind(m(b), "spend", "FOOD_AND_DRINK", 480000), ins.bind(m(b), "spend", "INTEREST", 3000)]));
    const { status, body } = await getJson<any>("/audit/advice");
    expect(status).toBe(200);
    expect(body.findings.map((f: any) => f.id)).toEqual(expect.arrayContaining(["card_interest", "savings_rate", "no_retirement"]));
    expect(body.findings[0].level).toBe("act");
    expect(body.checklist.length).toBeGreaterThanOrEqual(8);
    expect((await getJson("/audit/advice?owner=nobody")).status).toBe(422);
  });

  it("PUT /audit/checklist ticks and unticks an item", async () => {
    const send = (b: unknown) => getJson<any>("/audit/checklist", { method: "PUT", body: JSON.stringify(b) });
    expect((await send({ id: "will", checked: true })).body).toEqual({ id: "will", checked_on: new Date().toISOString().slice(0, 10) });
    expect((await getJson<any>("/audit/advice")).body.checklist.find((i: any) => i.id === "will").due).toBe(false);
    await send({ id: "will", checked: false });
    expect((await getJson<any>("/audit/advice")).body.checklist.find((i: any) => i.id === "will").due).toBe(true);
    expect((await send({ id: "yacht", checked: true })).status).toBe(422);
    expect((await send({ id: "will", checked: "yes" })).status).toBe(422);
  });
});
