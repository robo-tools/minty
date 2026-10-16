import type { Env } from "./env";

/** Limits on what the pages can ask of Minty (docs/security-plan.md, step 2).
 *
 * Rate limits: Cloudflare's rate limiting bindings (wrangler.jsonc "ratelimits"), keyed by the
 * Access email: every API request counts against RL_GENERAL, searches and ABC loads also against
 * RL_SEARCH, and bank linking against RL_LINK. They're approximate (counted per Cloudflare
 * location, eventually consistent), so they slow a runaway tab or a stolen session down; they
 * aren't what protects the database.
 *
 * The D1 read budget does that. D1's free plan allows 5,000,000 rows read a day, then every read
 * fails until 00:00 UTC, sync included. Each request's rows_read is added up; a request that read
 * more than COUNT_ABOVE_ROWS adds its total to a per-day counter in app_state (one upsert; cheap
 * requests never write). Once the day's count passes READ_BUDGET_PER_DAY, the routes whose reads
 * grow with the household's transactions are refused until 00:00 UTC, which leaves the rest of
 * the quota to sync and the cheap routes. The cron never checks the budget. */

export const COUNT_ABOVE_ROWS = 1000;
export const DEFAULT_READ_BUDGET = 3_000_000;
export const KEEP_READ_DAYS = 7;
const READ_KEY = "rows_read:";

type Limiter = "RL_GENERAL" | "RL_SEARCH" | "RL_LINK";
export const LIMITERS: Limiter[] = ["RL_GENERAL", "RL_SEARCH", "RL_LINK"];

const isSearch = (url: URL) =>
  url.pathname === "/transactions" && (!!url.searchParams.get("q") || url.searchParams.getAll("tag").some((t) => t.trim() !== ""));

/** The limiters a request counts against, in the order they're asked. */
export function limitersFor(method: string, url: URL): Limiter[] {
  const out: Limiter[] = ["RL_GENERAL"];
  if (url.pathname.startsWith("/link/") || url.pathname === "/liabilities/verify-history") out.push("RL_LINK");
  else if (method === "GET" && (url.pathname === "/benefits" || url.pathname.startsWith("/liabilities") || isSearch(url))) out.push("RL_SEARCH");
  return out;
}

/** True when one of the request's limiters refuses it. A missing binding isn't asked (the live
 * demo, or a config without "ratelimits"; Setup checks say so), and a limiter that throws lets the
 * request through: a hiccup on Cloudflare's side mustn't lock the household out. */
export async function rateLimited(env: Env, email: string, method: string, url: URL): Promise<boolean> {
  for (const name of limitersFor(method, url)) {
    const limiter = env[name];
    if (!limiter) continue;
    try {
      if (!(await limiter.limit({ key: email })).success) return true;
    } catch (e) {
      console.error(`rate limit ${name} failed, request allowed:`, e instanceof Error ? e.message : e);
    }
  }
  return false;
}

/** Routes whose reads grow with transaction or balance history: refused once the day's budget is spent. */
export const isHeavyRead = (method: string, url: URL) =>
  method === "POST" && url.pathname === "/liabilities/verify-history"
  || method === "GET" && ["/transactions", "/accounts", "/benefits", "/liabilities", "/liabilities/history", "/liabilities/payments",
    "/audit", "/audit/advice", "/retirement"].includes(url.pathname);

/** READ_BUDGET_PER_DAY: unset or blank = the default; "0" = no budget; anything that isn't a whole
 * number = the default, and Setup checks flag it (rather than refusing every request). */
export function readBudget(env: Env): { budget: number; valid: boolean } {
  const raw = (env.READ_BUDGET_PER_DAY ?? "").trim();
  if (!raw) return { budget: DEFAULT_READ_BUDGET, valid: true };
  if (!/^\d+$/.test(raw)) return { budget: DEFAULT_READ_BUDGET, valid: false };
  return { budget: Number(raw), valid: true };
}

const readKey = (now: Date) => `${READ_KEY}${now.toISOString().slice(0, 10)}`;   // the UTC date, like D1's quota

/** Rows counted so far today (UTC). One primary-key read. */
export async function readsToday(db: D1Database, now = new Date()): Promise<number> {
  const row = await db.prepare("SELECT value FROM app_state WHERE key = ?").bind(readKey(now)).first<{ value: string | null }>();
  return Number(row?.value ?? 0) || 0;
}

/** The day's budget is spent: the refusal message, else null. If the counter can't be read, the
 * request goes ahead (the handler would hit the same database anyway). */
export async function budgetRefusal(env: Env, now = new Date()): Promise<string | null> {
  const { budget } = readBudget(env);
  if (!budget) return null;
  const used = await readsToday(env.DB, now).catch(() => 0);
  if (used <= budget) return null;
  return `Minty has read more from its database today than its daily budget (${budget.toLocaleString("en-US")} rows, ` +
    "READ_BUDGET_PER_DAY). Browsing and search pause until 00:00 UTC, so syncing keeps working.";
}

/** Adds a request's rows to today's counter: one upsert. */
export async function recordReads(db: D1Database, rows: number, now = new Date()): Promise<void> {
  await db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (key) DO UPDATE SET value = CAST(app_state.value AS INTEGER) + CAST(excluded.value AS INTEGER),
       updated_at = excluded.updated_at`).bind(readKey(now), String(rows)).run();
}

/** Hourly cron: drop counters older than KEEP_READ_DAYS (a range on the primary key). */
export async function pruneReadCounts(db: D1Database, now = new Date()): Promise<void> {
  const cutoff = readKey(new Date(now.getTime() - KEEP_READ_DAYS * 86_400_000));
  await db.prepare("DELETE FROM app_state WHERE key >= ? AND key < ?").bind(READ_KEY, cutoff).run();
}

/** A D1 that adds up meta.rows_read for every statement run through it. first() doesn't report
 * meta, so it runs as all() and takes the first row (every first() in Minty reads one row anyway).
 * Per statement only: no per-row work. */
export function countingDb(db: D1Database): { db: D1Database; rows: () => number } {
  let rows = 0;
  const note = <T>(r: T): T => {
    rows += (r as { meta?: { rows_read?: number } } | null)?.meta?.rows_read ?? 0;
    return r;
  };
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = {
      bind: (...values: unknown[]) => wrap(s.bind(...values)),
      all: async () => note(await s.all()),
      run: async () => note(await s.run()),
      raw: (options?: { columnNames?: boolean }) => s.raw(options as { columnNames: true }),   // reports no meta; unused in src
      first: async (column?: string) => {
        const row = (note(await s.all()).results[0] ?? null) as Record<string, unknown> | null;
        return column === undefined ? row : row === null ? null : row[column];
      },
    };
    inner.set(w, s);
    return w as unknown as D1PreparedStatement;
  };
  const counted = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (stmts: D1PreparedStatement[]) => (await db.batch(stmts.map((x) => inner.get(x) ?? x))).map(note),
    exec: (sql: string) => db.exec(sql),
    dump: () => (db as unknown as { dump: () => Promise<ArrayBuffer> }).dump(),
    withSession: (c?: string) => db.withSession(c as D1SessionConstraint),
  };
  return { db: counted as unknown as D1Database, rows: () => rows };
}
