import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { IN_RETIREMENT } from "../investments";
import { CHECKED, LIMITS, kindOf } from "../retirement/limits";

/** EGG, phase E2 (docs/cfa.md §3): what the retirement view shows. Reads only what's stored (the
 * accounts, their daily balance snapshots, the holdings and investment transactions the cron
 * fetched), never Plaid. The browser draws the trend and works out the forecast. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const HISTORY_YEARS = 5;

// Every query here starts from the accounts (CROSS JOIN fixes SQLite's join order), so it reads only
// the retirement accounts' rows through their (account, date) indexes, never every transaction or
// snapshot (left to itself, SQLite walked the whole transactions table by date: 8,000 rows).
//
// Cash-like contributions into an account: Plaid's investment transactions credit cash with a
// negative amount; an HSA held at a bank shows them as money coming in (but not its interest).
const CONTRIBUTED = `
  SELECT a.owner, a.subtype, strftime('%Y', it.date) AS year, -sum(it.amount_cents) AS cents,
         -sum(CASE WHEN it.date >= date('now', '-365 days') THEN it.amount_cents ELSE 0 END) AS last_12m
  FROM accounts a CROSS JOIN investment_txns it ON it.account_id = a.id
  WHERE it.date >= ?1 AND it.amount_cents < 0 AND it.subtype IN ('contribution', 'deposit')         -- not a rollover or transfer: those don't count against a limit
    AND ${IN_RETIREMENT("a")}
  GROUP BY a.owner, a.subtype, year
  UNION ALL
  SELECT a.owner, a.subtype, strftime('%Y', t.date) AS year, -sum(t.amount_cents) AS cents,
         -sum(CASE WHEN t.date >= date('now', '-365 days') THEN t.amount_cents ELSE 0 END) AS last_12m
  FROM accounts a CROSS JOIN transactions t ON t.account_id = a.id
  WHERE a.type = 'depository' AND a.subtype = 'hsa' AND ${IN_RETIREMENT("a")} AND t.date >= ?1 AND t.pending = 0
    AND t.amount_cents < 0 AND coalesce(t.category, '') <> 'INCOME' AND upper(t.name) NOT LIKE '%INTEREST%'
  GROUP BY a.owner, a.subtype, year`;

// What the retirement accounts hold, by kind of asset. Plaid's security types don't tell a bond
// fund from a stock fund, so fund names do (a guess, and the page says so).
const MIX = `
  SELECT CASE
           WHEN s.is_cash_equivalent = 1 OR s.type = 'cash' OR upper(s.name) LIKE '%MONEY MARKET%' THEN 'cash'
           WHEN s.type = 'fixed income' OR upper(s.name) LIKE '%BOND%' OR upper(s.name) LIKE '%TREASUR%' OR upper(s.name) LIKE '%FIXED INCOME%' THEN 'bonds'
           WHEN upper(s.name) LIKE '%TARGET%' OR upper(s.name) LIKE '%RETIREMENT 20%' OR upper(s.name) LIKE '%LIFESTRATEGY%' OR upper(s.name) LIKE '%BALANCED%' THEN 'blend'
           WHEN s.type IN ('equity', 'etf', 'mutual fund') THEN 'stocks'
           ELSE 'other' END AS class,
         sum(h.value_cents) AS cents
  FROM accounts a CROSS JOIN holdings h ON h.account_id = a.id LEFT JOIN securities s ON s.security_id = h.security_id
  WHERE ${IN_RETIREMENT("a")}`;

const FEES = `
  SELECT a.owner, sum(it.amount_cents) AS cents FROM accounts a CROSS JOIN investment_txns it ON it.account_id = a.id
  WHERE it.date >= ?1 AND it.amount_cents > 0 AND (it.type = 'fee' OR it.subtype LIKE '%fee%') AND ${IN_RETIREMENT("a")}`;

const PROFILE_KEY = (owner: string) => `retirement_profile:${owner}`;

/** GET /retirement?owner=: the retirement accounts (and the other investment accounts, which can be
 * moved in), their balance history, contributions per year, fees this year, the mix, each
 * person's profile, and this year's limits. */
export async function retirement(env: Env, config: Config, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner");
  if (owner !== null && !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  const year = new Date().getUTCFullYear();
  const by = (col: string) => (owner === null ? "" : ` AND ${col} = ?`);
  const who = owner === null ? [] : [owner];
  const since = `${year - 1}-01-01`;
  const [accounts, snapshots, contributions, fees, mix, profiles, banks] = await env.DB.batch([
    env.DB.prepare(`SELECT a.id, a.owner, a.name, a.mask, a.type, a.subtype, a.view, a.balance_current_cents AS balance, i.institution_name AS bank,
                           ${IN_RETIREMENT("a")} AS in_retirement
                    FROM accounts a JOIN items i ON i.id = a.item_id
                    WHERE (a.type = 'investment' OR ${IN_RETIREMENT("a")})${by("a.owner")}`).bind(...who),
    env.DB.prepare(`SELECT s.account_id, s.date, s.current_cents AS cents FROM accounts a CROSS JOIN balance_snapshots s ON s.account_id = a.id
                    WHERE ${IN_RETIREMENT("a")} AND s.date >= date('now', '-${HISTORY_YEARS} years')${by("a.owner")}`).bind(...who),
    env.DB.prepare(`SELECT * FROM (${CONTRIBUTED}) WHERE 1${by("owner")}`).bind(since, ...who),
    env.DB.prepare(`${FEES}${by("a.owner")} GROUP BY a.owner`).bind(`${year}-01-01`, ...who),
    env.DB.prepare(`${MIX}${by("a.owner")} GROUP BY class`).bind(...who),
    env.DB.prepare("SELECT key, value FROM app_state WHERE key LIKE 'retirement_profile:%'"),
    env.DB.prepare(`SELECT i.id AS item_id, i.institution_name AS bank, s.status, s.synced_at FROM investment_sync s JOIN items i ON i.id = s.item_id`),
  ]);
  const limits = LIMITS[year] ?? null;
  return json({
    today: new Date().toISOString().slice(0, 10), year, owner,
    accounts: (accounts.results as Record<string, unknown>[]).map((a) => ({ ...a, in_retirement: Boolean(a.in_retirement), kind: kindOf(a.subtype as string | null) })),
    snapshots: snapshots.results,
    contributions: (contributions.results as Record<string, unknown>[]).map((c) => ({ ...c, kind: kindOf(c.subtype as string | null) })),
    fees: fees.results,
    mix: mix.results,
    profiles: Object.fromEntries((profiles.results as { key: string; value: string }[]).map((p) => [p.key.slice("retirement_profile:".length), safeJson(p.value)])),
    banks: banks.results,
    limits: limits ? { ...limits, year, checked: CHECKED } : null,
  });
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return {}; } };

/** PUT /retirement/profile {owner, birth_year?, retire_age?, target_cents?, target_age?, match_pct?,
 * hsa_coverage?, beneficiaries_checked_on?}: one person's profile, every field optional (null
 * clears it). Replaces the stored one. */
export async function setProfile(env: Env, config: Config, request: Request): Promise<Response> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  const body = b as Record<string, unknown>;
  const owner = body.owner ?? [...config.users.keys()][0];
  if (typeof owner !== "string" || !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  const year = new Date().getUTCFullYear();
  const int = (k: string, lo: number, hi: number) => {
    const v = body[k];
    if (v === undefined || v === null || v === "") return null;
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw unprocessable(`${k} must be a whole number from ${lo} to ${hi}`);
    return v as number;
  };
  const given = (k: string) => body[k] !== undefined && body[k] !== null && body[k] !== "";
  const pick = (k: string, ok: (v: unknown) => boolean, why: string) => {
    if (!given(k)) return null;
    if (!ok(body[k])) throw unprocessable(why);
    return body[k];
  };
  const profile: Record<string, unknown> = {
    birth_year: int("birth_year", year - 110, year - 14),
    retire_age: int("retire_age", 40, 90),
    target_cents: int("target_cents", 0, 100_000_000_000),
    target_age: int("target_age", 40, 100),
    match_pct: pick("match_pct", (v) => typeof v === "number" && v >= 0 && v <= 25, "match_pct must be 0 to 25"),
    hsa_coverage: pick("hsa_coverage", (v) => v === "self" || v === "family", "hsa_coverage must be 'self' or 'family'"),
    beneficiaries_checked_on: pick("beneficiaries_checked_on", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v), "beneficiaries_checked_on must be a date (YYYY-MM-DD)"),
  };
  for (const k of Object.keys(profile)) if (profile[k] === null) delete profile[k];
  await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ${NOW})
                        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(PROFILE_KEY(owner), JSON.stringify(profile)).run();
  return json({ owner, profile });
}
