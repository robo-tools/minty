import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { call, getJson } from "./helpers";

// CFA, phase C2 (docs/cfa.md): GET /audit reads only what the cron prepared; PUT /audit/buckets
// saves a correction for the next run.
const db = env.DB;
const month = (back: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)).toISOString().slice(0, 7); };
const send = (method: string, path: string, body?: unknown) => getJson<any>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(async () => {
  await db.batch(["recurring_charges", "net_worth", "monthly_totals", "bucket_overrides", "transaction_tags", "transactions", "accounts", "items"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  await db.prepare("DELETE FROM app_state WHERE key LIKE 'audit_%'").run();
  const ins = db.prepare("INSERT INTO monthly_totals (month, owner, bucket, category, amount_cents, n) VALUES (?, ?, ?, ?, ?, ?)");
  await db.batch([
    ins.bind(month(1), "me", "income", "INCOME", -500000, 2), ins.bind(month(1), "me", "spend", "FOOD_AND_DRINK", 60000, 30),
    ins.bind(month(1), "spouse", "spend", "FOOD_AND_DRINK", 20000, 9), ins.bind(month(13), "me", "spend", "TRAVEL", 90000, 3),
  ]);
  await db.prepare("INSERT INTO net_worth (date, owner, assets_cents, debts_cents) VALUES ('2026-10-01', 'me', 900000, 50000), ('2026-10-01', 'spouse', 100000, 0)").run();
  await db.prepare(`INSERT INTO recurring_charges (owner, merchant, name, category, cadence, n, avg_cents, last_cents, prev_cents, distinct_amounts, first_date, last_date)
    VALUES ('me', 'NETFLIX', 'Netflix', 'ENTERTAINMENT', 'monthly', 6, 1590, 1799, 1549, 2, '2026-04-18', '2026-10-01')`).run();
});

describe("GET /audit", () => {
  it("is behind Access like every API route", async () => {
    expect((await call("/audit", { token: null })).status).toBe(403);
  });

  it("the last 12 months of totals, net worth, recurring charges, cards and corrections", async () => {
    const { status, body } = await getJson<any>("/audit");
    expect(status).toBe(200);
    expect(body.months).toHaveLength(12);
    expect(body.months.at(-1)).toBe(month(0));
    expect(body.totals).toEqual(expect.arrayContaining([
      { month: month(1), bucket: "spend", category: "FOOD_AND_DRINK", cents: 80000, n: 39 },          // both people, summed
      { month: month(1), bucket: "income", category: "INCOME", cents: -500000, n: 2 }]));
    expect(body.totals.some((t: any) => t.month === month(13))).toBe(false);                         // older than 12 months
    expect(body.net_worth).toEqual([{ date: "2026-10-01", assets: 1000000, debts: 50000 }]);
    expect(body.recurring).toEqual([expect.objectContaining({ merchant: "NETFLIX", cadence: "monthly", corrected: null })]);
    expect(body).toMatchObject({ cards: [], corrections: [], pending_rebuild: false });
  });

  it("24 months, and one person", async () => {
    expect((await getJson<any>("/audit?months=24")).body.totals.some((t: any) => t.month === month(13))).toBe(true);
    const { body } = await getJson<any>("/audit?owner=spouse");
    expect(body.totals).toEqual([{ month: month(1), bucket: "spend", category: "FOOD_AND_DRINK", cents: 20000, n: 9 }]);
    expect(body.net_worth).toEqual([{ date: "2026-10-01", assets: 100000, debts: 0 }]);
    expect(body.recurring).toEqual([]);
    expect((await getJson("/audit?owner=nobody")).status).toBe(422);
  });
});

describe("PUT /audit/buckets", () => {
  it("saves a correction (upper case), marks the totals for a rebuild, and removes it with null", async () => {
    expect((await send("PUT", "/audit/buckets", { merchant: "  netflix ", bucket: "transfer" })).body).toEqual({ merchant: "NETFLIX", bucket: "transfer" });
    let { body } = await getJson<any>("/audit");
    expect(body.corrections).toEqual([{ merchant: "NETFLIX", bucket: "transfer" }]);
    expect(body.recurring[0].corrected).toBe("transfer");
    expect(body.pending_rebuild).toBe(true);
    await send("PUT", "/audit/buckets", { merchant: "NETFLIX", bucket: "saving" });
    expect((await getJson<any>("/audit")).body.corrections).toEqual([{ merchant: "NETFLIX", bucket: "saving" }]);
    await send("PUT", "/audit/buckets", { merchant: "Netflix", bucket: null });
    ({ body } = await getJson<any>("/audit"));
    expect(body.corrections).toEqual([]);
  });

  it.each([[{ merchant: "", bucket: "saving" }], [{ merchant: "x".repeat(81), bucket: "saving" }], [{ merchant: "A", bucket: "fun" }], [{ merchant: "A" }]])("refuses %j", async (b) => {
    expect((await send("PUT", "/audit/buckets", b)).status).toBe(422);
  });
});
