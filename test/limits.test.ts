import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { accessToken, call, getJson, loadFixture } from "./helpers";
import { FakePlaid, account, page, txn } from "./fake-plaid";
import { fernetEncrypt } from "../src/fernet";
import {
  COUNT_ABOVE_ROWS, DEFAULT_READ_BUDGET, budgetRefusal, countingDb, limitersFor, pruneReadCounts, readsToday, recordReads,
} from "../src/limits";
import { MAX_BODY_BYTES } from "../src/http";

// Step 2 of docs/security-plan.md: rate limits per login, a cap on request bodies and search
// text, and the daily D1 read budget.

const E = env as unknown as Env;
const today = () => `rows_read:${new Date().toISOString().slice(0, 10)}`;
const daysAgo = (n: number) => `rows_read:${new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)}`;
const setCounter = (key: string, value: number) => E.DB.prepare(
  "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, String(value)).run();
const counter = async (key = today()) => (await E.DB.prepare("SELECT value FROM app_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
const clearCounters = () => E.DB.prepare("DELETE FROM app_state WHERE key LIKE 'rows_read:%'").run();
const byId = (checks: any[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

/** A limiter that allows `allow` calls, then refuses; records every key it's asked about. */
function limiter(allow = Infinity) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.length <= allow }; } };
}
const refusing = () => limiter(0);
/** A database that fails the test if anything touches it. */
const untouchable = new Proxy({}, { get: () => () => { throw new Error("D1 was used"); } }) as unknown as D1Database;

/** ~1,500 transactions, so a search that matches nothing reads well over COUNT_ABOVE_ROWS. */
async function loadMany(n = 1500) {
  await loadFixture();
  const rows = Array.from({ length: n }, (_, i) => [`bulk-${i}`, `2025-${String(1 + (i % 12)).padStart(2, "0")}-15`, `Shop ${i}`]);
  for (let i = 0; i < rows.length; i += 500) {
    await E.DB.prepare(`INSERT INTO transactions (owner, account_id, plaid_txn_id, amount_cents, date, name)
      SELECT 'me', 10, j.value ->> 0, 100, j.value ->> 1, j.value ->> 2 FROM json_each(?) j`).bind(JSON.stringify(rows.slice(i, i + 500))).run();
  }
}

beforeEach(clearCounters);
afterEach(() => vi.restoreAllMocks());

describe("rate limits", () => {
  it("the three bindings from wrangler.jsonc are wired up", () => {
    expect(typeof E.RL_GENERAL?.limit).toBe("function");
    expect(typeof E.RL_SEARCH?.limit).toBe("function");
    expect(typeof E.RL_LINK?.limit).toBe("function");
  });

  it("route by route: everything counts against the general limit, searches and ABC also the search one, linking the link one", () => {
    const at = (p: string, m = "GET") => limitersFor(m, new URL(`https://x${p}`));
    expect(at("/transactions")).toEqual(["RL_GENERAL"]);
    expect(at("/transactions?q=")).toEqual(["RL_GENERAL"]);                  // an empty search isn't one
    expect(at("/transactions?tag=+")).toEqual(["RL_GENERAL"]);
    expect(at("/transactions?q=shell")).toEqual(["RL_GENERAL", "RL_SEARCH"]);
    expect(at("/transactions?tag=travel")).toEqual(["RL_GENERAL", "RL_SEARCH"]);
    expect(at("/benefits")).toEqual(["RL_GENERAL", "RL_SEARCH"]);
    expect(at("/benefits/marks", "PUT")).toEqual(["RL_GENERAL"]);             // a tick; the reload that follows counts
    expect(at("/link/token", "POST")).toEqual(["RL_GENERAL", "RL_LINK"]);
    expect(at("/link/exchange", "POST")).toEqual(["RL_GENERAL", "RL_LINK"]);
    expect(at("/liabilities/verify-history", "POST")).toEqual(["RL_GENERAL", "RL_LINK"]);
    expect(at("/tags")).toEqual(["RL_GENERAL"]);
    expect(at("/status")).toEqual(["RL_GENERAL"]);
  });

  it("a refusal is a 429 with Retry-After, before any D1 work", async () => {
    const r = await call("/tags", { envOverrides: { RL_GENERAL: refusing(), DB: untouchable } as Partial<Env> });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect((await r.json() as any).detail).toBe("Too many requests. Wait a minute and try again.");
  });

  it("counts per login: the Access email is the key", async () => {
    const rl = limiter();
    await call("/tags", { envOverrides: { RL_GENERAL: rl } as Partial<Env> });
    await call("/tags", { token: await accessToken({ email: "Other@Example.com" }), envOverrides: { RL_GENERAL: rl } as Partial<Env> });
    expect(rl.keys).toEqual(["me@example.com", "other@example.com"]);
  });

  it("the general limit lets requests through up to the limit, then refuses", async () => {
    const rl = limiter(3);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await call("/tags", { envOverrides: { RL_GENERAL: rl } as Partial<Env> })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("the search limit refuses searches and ABC only", async () => {
    await loadFixture();
    const o = { envOverrides: { RL_SEARCH: refusing() } as Partial<Env> };
    expect((await call("/transactions", o)).status).toBe(200);
    expect((await call("/transactions?q=", o)).status).toBe(200);
    expect((await call("/transactions?q=shell", o)).status).toBe(429);
    expect((await call("/transactions?tag=travel", o)).status).toBe(429);
    expect((await call("/benefits", o)).status).toBe(429);
    expect((await call("/tags", o)).status).toBe(200);
    expect((await call("/accounts", o)).status).toBe(200);
  });

  it("the link limit refuses linking before Plaid is called, and nothing else", async () => {
    await loadFixture();
    const plaid = new FakePlaid().install();
    const o = { envOverrides: { RL_LINK: refusing() } as Partial<Env> };
    const r = await call("/link/token", { ...o, method: "POST", body: JSON.stringify({ owner: "me" }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(429);
    expect(plaid.calls).toEqual([]);                                          // no link token, no Trial slot touched
    expect((await call("/transactions", o)).status).toBe(200);
  });

  it("missing bindings aren't a lockout: nothing is limited, and Setup checks say so", async () => {
    const off = { RL_GENERAL: undefined, RL_SEARCH: undefined, RL_LINK: undefined } as Partial<Env>;
    expect((await call("/tags", { envOverrides: off })).status).toBe(200);
    const c = byId((await getJson("/status", { envOverrides: off })).body.checks);
    expect(c.rate_limits).toMatchObject({ ok: false, level: "warn", message: "Rate limits are off (missing RL_GENERAL, RL_SEARCH, RL_LINK)." });
    const partly = byId((await getJson("/status", { envOverrides: { RL_LINK: undefined } as Partial<Env> })).body.checks);
    expect(partly.rate_limits.message).toBe("Rate limits are off (missing RL_LINK).");
    expect(byId((await getJson("/status")).body.checks).rate_limits).toMatchObject({ ok: true, message: "Rate limits are on (per login, per minute)." });
  });

  it("a limiter that fails lets the request through, and logs it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { limit: async () => { throw new Error("binding unavailable"); } };
    expect((await call("/tags", { envOverrides: { RL_GENERAL: broken } as Partial<Env> })).status).toBe(200);
    expect(err).toHaveBeenCalledWith("rate limit RL_GENERAL failed, request allowed:", "binding unavailable");
  });

  it("signing in comes first: without Access, a request is refused before it's counted", async () => {
    const rl = limiter();
    expect((await call("/tags", { token: null, envOverrides: { RL_GENERAL: rl } as Partial<Env> })).status).toBe(403);
    expect(rl.keys).toEqual([]);
  });
});

describe("request size", () => {
  beforeAll(loadFixture);
  const put = (body: BodyInit, headers: Record<string, string> = {}) =>
    call("/transactions/100/tags", { method: "PUT", body, headers: { "content-type": "application/json", ...headers } });

  it("a body over 16 KiB is refused with 413, by its Content-Length, before it's read", async () => {
    const r = await put(JSON.stringify({ tags: ["x".repeat(MAX_BODY_BYTES)] }));
    expect(r.status).toBe(413);
    expect((await r.json() as any).detail).toBe("request body too large (at most 16 KiB)");
  });

  it("a streamed body without Content-Length is cut off at 16 KiB too", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(4096));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent++ < 8) c.enqueue(chunk); else c.close(); } });
    const r = await put(stream);
    expect(r.status).toBe(413);
  });

  it("normal bodies still work, and bad JSON keeps its old message", async () => {
    expect((await put(JSON.stringify({ tags: ["groceries"] }))).status).toBe(200);
    const bad = await put("{not json");
    expect(bad.status).toBe(422);
    expect((await bad.json() as any).detail).toBe('body must be JSON: {"tags": [...]}');
    const link = await call("/link/reconnected", { method: "POST", body: "[]", headers: { "content-type": "application/json" } });
    expect((await link.json() as any).detail).toBe("body must be a JSON object");
  });

  it("search text is at most 48 bytes, D1's LIKE limit with the two %s (longer used to fail with a 500)", async () => {
    expect((await call(`/transactions?q=${"a".repeat(48)}`)).status).toBe(200);
    const r = await call(`/transactions?q=${"a".repeat(49)}`);
    expect(r.status).toBe(422);
    expect((await r.json() as any).detail).toBe("search text must be at most 48 characters (fewer with accents or emoji)");
    expect((await call(`/transactions?q=${encodeURIComponent("é".repeat(24))}`)).status).toBe(200);   // 48 bytes
    expect((await call(`/transactions?q=${encodeURIComponent("é".repeat(25))}`)).status).toBe(422);
  });
});

describe("the daily D1 read budget", () => {
  beforeAll(() => loadMany());

  it("a request that reads more than 1,000 rows adds them to today's counter; a cheap one writes nothing", async () => {
    expect((await call("/tags")).status).toBe(200);
    expect(await counter()).toBeNull();
    expect((await call("/transactions?q=matches-nothing")).status).toBe(200);   // reads every transaction
    const first = Number(await counter());
    expect(first).toBeGreaterThan(1500);
    await call("/transactions?q=matches-nothing");
    expect(Number(await counter())).toBe(first * 2);                            // added, not replaced
  });

  it("past the budget, the heavy routes are refused until tomorrow; the rest keep working", async () => {
    await setCounter(today(), DEFAULT_READ_BUDGET + 1);
    for (const path of ["/transactions", "/transactions?q=shell", "/accounts", "/benefits"]) {
      const r = await call(path);
      expect(r.status, path).toBe(429);
      expect((await r.json() as any).detail, path).toMatch(/^Minty has read more from its database today than its daily budget \(3,000,000 rows, READ_BUDGET_PER_DAY\)\. Browsing and search pause until 00:00 UTC/);
    }
    for (const path of ["/tags", "/items", "/health", "/users", "/capacity", "/sync-request", "/status"]) {
      expect((await call(path)).status, path).toBe(200);
    }
    const tag = await call("/transactions/100/tags", { method: "PUT", body: JSON.stringify({ tags: ["groceries"] }), headers: { "content-type": "application/json" } });
    expect(tag.status).toBe(200);                                                // edits aren't reads of the whole table
    const c = byId((await getJson("/status")).body.checks);
    expect(c.read_budget).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("passed the daily budget of 3,000,000") });
  });

  it("only a day over the budget is refused: at the budget, or yesterday's count, still works", async () => {
    await setCounter(today(), DEFAULT_READ_BUDGET);
    expect((await call("/accounts")).status).toBe(200);
    await clearCounters();
    await setCounter(daysAgo(1), DEFAULT_READ_BUDGET * 2);
    expect((await call("/accounts")).status).toBe(200);
  });

  it("READ_BUDGET_PER_DAY sets the budget; 0 turns it off; anything else falls back to the default and is flagged", async () => {
    await setCounter(today(), DEFAULT_READ_BUDGET + 1);
    expect((await call("/accounts", { envOverrides: { READ_BUDGET_PER_DAY: "5000000" } })).status).toBe(200);
    expect((await call("/accounts", { envOverrides: { READ_BUDGET_PER_DAY: "1000" } })).status).toBe(429);
    expect((await call("/accounts", { envOverrides: { READ_BUDGET_PER_DAY: "0" } })).status).toBe(200);
    expect(byId((await getJson("/status", { envOverrides: { READ_BUDGET_PER_DAY: "0" } })).body.checks).read_budget)
      .toMatchObject({ ok: true, message: "No daily D1 read budget (READ_BUDGET_PER_DAY is 0). Counted today: 3,000,001 rows." });
    expect((await call("/accounts", { envOverrides: { READ_BUDGET_PER_DAY: "lots" } })).status).toBe(429);
    expect(byId((await getJson("/status", { envOverrides: { READ_BUDGET_PER_DAY: "lots" } })).body.checks).read_budget)
      .toMatchObject({ ok: false, level: "error", message: "READ_BUDGET_PER_DAY isn't a whole number, so the default (3,000,000 rows) is used." });
  });

  it("if the counter can't be read, requests go ahead", async () => {
    const broken = { prepare: () => { throw new Error("D1 down"); } } as unknown as D1Database;
    expect(await budgetRefusal({ ...E, DB: broken })).toBeNull();
  });

  it("the cron never checks the budget: it syncs on a day past it, then prunes old counters", async () => {
    await setCounter(today(), DEFAULT_READ_BUDGET * 10);
    for (const n of [1, 7, 8, 30]) await setCounter(daysAgo(n), 5);
    const plaid = new FakePlaid().install();
    const enc = await fernetEncrypt("access-sandbox-secret", E.TOKEN_ENC_KEY!);
    await E.DB.prepare("UPDATE items SET access_token_enc = ? WHERE id = 1").bind(enc).run();
    await E.DB.prepare("UPDATE items SET status = 'demo' WHERE id <> 1").run();          // only item 1 syncs
    plaid.syncPages.push(page("c1", false, { accounts: [account("acct-10")], added: [txn("cron-txn", "acct-10")] }));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "17 * * * *" }), E, ctx);
    await waitOnExecutionContext(ctx);
    expect(plaid.paths()).toContain("/transactions/sync");
    expect(await E.DB.prepare("SELECT id FROM transactions WHERE plaid_txn_id = 'cron-txn'").first()).not.toBeNull();
    const keys = (await E.DB.prepare("SELECT key FROM app_state WHERE key LIKE 'rows_read:%' ORDER BY key").all<{ key: string }>()).results.map((r) => r.key);
    expect(keys).toEqual([daysAgo(7), daysAgo(1), today()]);                     // 8 and 30 days old are gone
  });

  it("pruning leaves other app_state keys alone", async () => {
    await E.DB.prepare("INSERT INTO app_state (key, value) VALUES ('last_sweep_at', 'x') ON CONFLICT (key) DO UPDATE SET value = 'x'").run();
    await setCounter(daysAgo(40), 1);
    await pruneReadCounts(E.DB);
    expect(await counter(daysAgo(40))).toBeNull();
    expect((await E.DB.prepare("SELECT value FROM app_state WHERE key = 'last_sweep_at'").first<{ value: string }>())!.value).toBe("x");
  });

  it("recordReads adds, readsToday reads back; both use today's UTC date", async () => {
    await recordReads(E.DB, 1200);
    await recordReads(E.DB, 34);
    expect(await readsToday(E.DB)).toBe(1234);
    expect(await readsToday(E.DB, new Date(Date.now() + 86_400_000))).toBe(0);
    expect(COUNT_ABOVE_ROWS).toBe(1000);
  });
});

describe("countingDb", () => {
  beforeAll(loadFixture);

  it("adds up rows_read across all(), run(), first() and batch(), and behaves like D1", async () => {
    const { db, rows } = countingDb(E.DB);
    expect((await db.prepare("SELECT id FROM transactions ORDER BY id").all<{ id: number }>()).results.map((r) => r.id)).toEqual([100, 101, 102, 200, 201]);
    const afterAll = rows();
    expect(afterAll).toBeGreaterThanOrEqual(5);
    expect(await db.prepare("SELECT id, name FROM transactions WHERE id = ?").bind(200).first()).toEqual({ id: 200, name: "Netflix" });
    expect(await db.prepare("SELECT name FROM transactions WHERE id = ?").bind(200).first("name")).toBe("Netflix");
    expect(await db.prepare("SELECT id FROM transactions WHERE id = -1").first()).toBeNull();
    expect(rows()).toBeGreaterThan(afterAll);
    const beforeBatch = rows();
    const [a, b] = await db.batch([db.prepare("SELECT count(*) AS n FROM transactions"), db.prepare("SELECT count(*) AS n FROM accounts")]);
    expect([(a.results[0] as any).n, (b.results[0] as any).n]).toEqual([5, 3]);
    expect(rows()).toBeGreaterThan(beforeBatch);
  });
});

describe("Setup checks that GET-STARTED promises are all ✓", () => {
  it("a household that followed GET-STARTED (ALLOWED_LOGINS set, bindings present, under budget) gets no new warning", async () => {
    const c = byId((await getJson("/status", { envOverrides: { ALLOWED_LOGINS: "me@example.com" } })).body.checks);
    expect(c.allowed_logins).toMatchObject({ ok: true, message: "ALLOWED_LOGINS lists 1 login." });
    expect(c.rate_limits.ok).toBe(true);
    expect(c.read_budget).toMatchObject({ ok: true, message: "D1 rows read today: 0 counted, of a daily budget of 3,000,000." });
  });

  it("an empty ALLOWED_LOGINS is flagged, with the fix", async () => {
    const c = byId((await getJson("/status")).body.checks);
    expect(c.allowed_logins).toMatchObject({ ok: false, level: "warn", message: expect.stringContaining("ALLOWED_LOGINS is empty"),
      fix: "Set the variable ALLOWED_LOGINS to the same addresses as your Access policy, comma-separated." });
    expect(byId((await getJson("/status", { envOverrides: { ALLOWED_LOGINS: " me@example.com , b@example.com " } })).body.checks).allowed_logins.message)
      .toBe("ALLOWED_LOGINS lists 2 logins.");
  });
});
