import type { Env } from "../env";
import { LIMITS, type Limits } from "./limits";

/** The IRS contribution limits, fetched from irs.gov once a year and kept (EGG, docs/cfa.md §3).
 *
 * Two IRS pages, each with a stable address:
 *  - the COLA table (401(k)/403(b)/457(b) deferrals and catch-up, IRA, SIMPLE, and the 60–63
 *    catch-ups in its footnotes), with a column per year: the next year's appears in November;
 *  - Publication 969 (HSA limits, "For 2026, if you have self-only HDHP coverage, you can
 *    contribute up to $4,400 …"), with the coming year's in its tip once it's published.
 *
 * Each page is asked only while a year it should have isn't settled yet, at most once a week, from
 * a quiet catch-up cron run (never on a request). Once a year's figures are in, that page isn't
 * asked again for that year: one request a year when the IRS has published. Every figure is
 * checked before it's kept: whole dollars (a multiple of $50), and within 0.9× to 1.5× the last
 * value known (the values in limits.ts, or an earlier year fetched). The code values stay the
 * fallback, and a year not published yet shows the year before, marked as such. */

export const COLA_URL = "https://www.irs.gov/retirement-plans/cola-increases-for-dollar-limitations-on-benefits-and-contributions";
export const PUB969_URL = "https://www.irs.gov/publications/p969";
const RETRY_DAYS = 7;
const MAX_PAGE_CHARS = 1_500_000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

type Field = Exclude<keyof Limits, "sources">;
export type Partial_ = Partial<Record<Field, number>>;
const COLA_FIELDS: Field[] = ["workplace", "workplaceCatchUp50", "workplaceCatchUp60to63", "ira", "iraCatchUp50", "simple", "simpleCatchUp50"];
const HSA_FIELDS: Field[] = ["hsaSelf", "hsaFamily", "hsaCatchUp55"];

const dollars = (s: string) => Math.round(Number(s.replace(/[$,*\s]/g, "")) * 100);
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The COLA table's figures for every year it shows: { 2026: { workplace, ... }, 2025: {...} }. */
export function parseCola(html: string): Record<number, Partial_> {
  const start = html.indexOf("IRA contribution limit");
  if (start < 0) return {};
  // Only the tables' stretch of the page is turned into text (the page is ~100 KB; this is ~30 KB).
  const t = text(html.slice(Math.max(0, start - 3000), start + 40000));
  const head = /IRAs\s+((?:20\d\d\s+)+)/.exec(t);
  if (!head) return {};
  const years = head[1].trim().split(/\s+/).map(Number);
  const NUM = String.raw`\$?[\d,]+\**`;
  const row = (label: string, from = 0) => {
    const re = new RegExp(label + String.raw`\s+((?:${NUM}\s+){${years.length - 1}}${NUM})`);
    const m = re.exec(t.slice(from));
    return m ? { values: m[1].trim().split(/\s+/).map(dollars), at: from + m.index } : null;
  };
  const out: Record<number, Partial_> = Object.fromEntries(years.map((y) => [y, {}]));
  const put = (field: Field, r: { values: number[] } | null) => r?.values.forEach((v, i) => { if (Number.isFinite(v)) out[years[i]][field] = v; });
  put("ira", row("IRA contribution limit"));
  put("iraCatchUp50", row("IRA catch-up contributions"));
  const simple = row("SIMPLE maximum contributions");
  put("simple", simple);
  if (simple) put("simpleCatchUp50", row("Catch-up contributions", simple.at));
  const deferrals = row("Elective deferrals");
  put("workplace", deferrals);
  if (deferrals) put("workplaceCatchUp50", row("Catch-up contributions", deferrals.at));
  // Footnotes: "For 2026, this higher catch-up contribution limit is $11,250". The 401(k) one is the
  // one after the 401(k) table (the SIMPLE one, before it, isn't a limit EGG shows).
  for (const m of t.matchAll(/For (20\d\d), this higher catch-up contribution limit is (\$[\d,]+)/g)) {
    const y = Number(m[1]);
    if (out[y] && deferrals && m.index! > deferrals.at) out[y].workplaceCatchUp60to63 = dollars(m[2]);
  }
  return out;
}

/** Publication 969's HSA figures for every year it states: { 2026: { hsaSelf, hsaFamily, hsaCatchUp55 } }. */
export function parsePub969(html: string): Record<number, Partial_> {
  // Only the stretches that hold the figures become text: the page is ~300 KB, and turning all of
  // it into text would cost a good part of the free plan's 10 ms of CPU.
  const around = (needle: string, before: number, after: number) => {
    const i = html.indexOf(needle);
    return i < 0 ? "" : text(html.slice(Math.max(0, i - before), i + after));
  };
  const t = around("self-only HDHP coverage, you can contribute up to", 1500, 6000) + " " + around("age 55 or older at the end of your tax year", 500, 1500);
  const out: Record<number, Partial_> = {};
  const re = /For (20\d\d), if you have self-only HDHP coverage, you can contribute up to (\$[\d,]+)\. If you have family HDHP coverage, you can contribute up to (\$[\d,]+)/g;
  const catchUp = /age 55 or older at the end of your tax year, your contribution limit is increased by (\$[\d,]+)/.exec(t);
  for (const m of t.matchAll(re)) {
    out[Number(m[1])] = { hsaSelf: dollars(m[2]), hsaFamily: dollars(m[3]), ...(catchUp ? { hsaCatchUp55: dollars(catchUp[1]) } : {}) };
  }
  return out;
}

const key = (year: number) => `irs_limits:${year}`;
interface Stored { values: Partial_; settled: { cola?: string; pub969?: string } }

async function stored(env: Env, years: number[]): Promise<Record<number, Stored>> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM app_state WHERE key IN (${years.map(() => "?").join(", ")})`)
    .bind(...years.map(key)).all<{ key: string; value: string }>();
  const out: Record<number, Stored> = {};
  for (const r of results) { try { out[Number(r.key.slice("irs_limits:".length))] = JSON.parse(r.value); } catch {} }
  return out;
}

/** The last value known for a field before `year`: an earlier year fetched, or the code's. */
function baseline(field: Field, year: number, have: Record<number, Stored>): number | null {
  for (let y = year - 1; y >= year - 5; y--) {
    const v = have[y]?.values[field] ?? LIMITS[y]?.[field];
    if (typeof v === "number") return v;
  }
  return (LIMITS[year]?.[field] as number | undefined) ?? null;
}

/** Keeps only the figures that look right: whole dollars in steps of $50, near the last known value. */
export function sane(values: Partial_, year: number, have: Record<number, Stored>): Partial_ {
  const out: Partial_ = {};
  for (const [f, v] of Object.entries(values) as [Field, number][]) {
    const base = baseline(f, year, have);
    if (!Number.isInteger(v) || v <= 0 || v % 5000 !== 0) continue;
    if (base !== null && (v < base * 0.9 || v > base * 1.5)) continue;
    out[f] = v;
  }
  return out;
}

/** The quiet catch-up run's step: asks each IRS page at most once a week, and only while a year it
 * should have isn't settled: this year, and from November next year (the COLA table only; HSA
 * figures come with Publication 969 in the new year). Returns what it asked and kept. */
export async function refreshIrsLimits(env: Env, now = new Date(), fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if ((env.IRS_LIMITS ?? "").trim().toLowerCase() === "off") return {};
  const year = now.getUTCFullYear(), today = now.toISOString().slice(0, 10);
  const wanted: Record<"cola" | "pub969", number[]> = { cola: now.getUTCMonth() >= 10 ? [year, year + 1] : [year], pub969: [year] };
  const have = await stored(env, [year - 1, year, year + 1]);
  const tried = Object.fromEntries((await env.DB.prepare("SELECT key, value FROM app_state WHERE key IN ('irs_tried:cola', 'irs_tried:pub969')")
    .all<{ key: string; value: string }>()).results.map((r) => [r.key.slice("irs_tried:".length), r.value]));
  const report: Record<string, unknown> = {};
  for (const page of ["cola", "pub969"] as const) {
    const need = wanted[page].filter((y) => !have[y]?.settled[page]);
    if (!need.length) continue;
    if (tried[page] && (Date.parse(today) - Date.parse(tried[page])) / 864e5 < RETRY_DAYS) continue;
    await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ${NOW}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(`irs_tried:${page}`, today).run();
    let parsed: Record<number, Partial_> = {};
    try {
      const r = await fetcher(page === "cola" ? COLA_URL : PUB969_URL, { headers: { "User-Agent": "Minty (self-hosted; https://github.com/rg-code/minty)" } });
      const body = r.ok ? await r.text() : "";
      if (body.length <= MAX_PAGE_CHARS) parsed = page === "cola" ? parseCola(body) : parsePub969(body);
      report[page] = r.ok ? "asked" : `HTTP ${r.status}`;
    } catch (e) {
      report[page] = `failed: ${e instanceof Error ? e.message : e}`;
      continue;
    }
    const writes: D1PreparedStatement[] = [];
    for (const y of need) {
      const ok = sane(parsed[y] ?? {}, y, have);
      const fields = page === "cola" ? COLA_FIELDS.filter((f) => f !== "workplaceCatchUp60to63") : HSA_FIELDS.filter((f) => f !== "hsaCatchUp55");
      if (!fields.every((f) => f in ok)) { report[`${page}:${y}`] = "not published yet, or didn't look right"; continue; }
      const s: Stored = have[y] ?? { values: {}, settled: {} };
      s.values = { ...s.values, ...ok };
      s.settled = { ...s.settled, [page]: today };
      have[y] = s;
      writes.push(env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ${NOW}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(key(y), JSON.stringify(s)));
      report[`${page}:${y}`] = ok;
    }
    if (writes.length) await env.DB.batch(writes);
  }
  return report;
}

export interface YearLimits extends Limits { year: number; checked: string; fetched: boolean; provisional: Field[] }

/** This year's limits for EGG and the audit: fetched figures over the code's; a figure the IRS
 * hasn't published for this year yet is last year's, listed in `provisional`. */
export async function limitsFor(env: Env, year: number, checked: string): Promise<YearLimits | null> {
  const have = await stored(env, [year - 1, year]);
  const code = LIMITS[year], prev = LIMITS[year - 1];
  const fields = [...COLA_FIELDS, ...HSA_FIELDS];
  const out: Record<string, unknown> = { year, checked, sources: code?.sources ?? [COLA_URL, PUB969_URL], fetched: Boolean(have[year]) };
  const provisional: Field[] = [];
  for (const f of fields) {
    const v = have[year]?.values[f] ?? code?.[f] ?? null;
    if (typeof v === "number") { out[f] = v; continue; }
    const last = have[year - 1]?.values[f] ?? prev?.[f];
    if (typeof last === "number") { out[f] = last; provisional.push(f); }
  }
  if (!fields.some((f) => typeof out[f] === "number")) return null;
  return { ...(out as unknown as Limits), year, checked, fetched: Boolean(have[year]), provisional };
}
