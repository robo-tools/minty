import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { IN_RETIREMENT } from "../investments";
import { CHECKED, CHECKLIST, checklist, recommend, type AdviceInput, type Month } from "../audit/rules";
import { retirementData } from "./retirement";

/** CFA, phase C3 (docs/cfa.md §2.3): GET /audit/advice runs the rules (src/audit/rules.ts) on what
 * the cron prepared (monthly totals, recurring charges) and what's stored (balances, retirement
 * data, holdings), never the transactions; PUT /audit/checklist ticks a planner's checklist item. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const CHECKLIST_KEY = "audit_checklist";

const monthsBack = (n: number, now = new Date()) =>
  Array.from({ length: n }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1)).toISOString().slice(0, 7));
const parse = (s: string | null | undefined) => {
  try {
    const value = JSON.parse(s ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
};

export async function advice(env: Env, config: Config, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner");
  if (owner !== null && !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  const months = monthsBack(12);                  // the audit's own window, so both judge from the same months
  const by = (col: string) => (owner === null ? "" : ` AND ${col} = ?`);
  const who = owner === null ? [] : [owner];
  const [totals, recurring, cash, holdings, state] = await env.DB.batch([
    env.DB.prepare(`SELECT month, bucket, category, sum(amount_cents) AS cents, sum(n) AS n FROM monthly_totals
                    WHERE month >= ?${by("owner")} GROUP BY month, bucket, category`).bind(months[0], ...who),
    env.DB.prepare(`SELECT r.name, r.merchant, r.cadence, r.category, r.avg_cents, r.last_cents, r.prev_cents, r.distinct_amounts, r.last_date, o.bucket AS corrected
                    FROM recurring_charges r LEFT JOIN bucket_overrides o ON o.merchant = r.merchant WHERE 1${by("r.owner")}`).bind(...who),
    env.DB.prepare(`SELECT coalesce(sum(CASE WHEN subtype IN ('checking', 'prepaid', 'cash management') THEN balance_current_cents END), 0) AS checking,
                           coalesce(sum(CASE WHEN subtype IN ('savings', 'money market', 'cd') THEN balance_current_cents END), 0) AS savings
                    FROM accounts WHERE type = 'depository' AND NOT ${IN_RETIREMENT("accounts")}${by("owner")}`).bind(...who),
    env.DB.prepare(`SELECT s.name, s.type, sum(h.value_cents) AS cents,
                           max(CASE WHEN NOT ${IN_RETIREMENT("a")} THEN 1 ELSE 0 END) AS taxable
                    FROM accounts a CROSS JOIN holdings h ON h.account_id = a.id LEFT JOIN securities s ON s.security_id = h.security_id
                    WHERE a.type = 'investment'${by("a.owner")} GROUP BY h.security_id`).bind(...who),
    env.DB.prepare(`SELECT value FROM app_state WHERE key = '${CHECKLIST_KEY}'`),
  ]);

  const byMonth = new Map<string, Month>(months.map((m) => [m, { month: m, income: 0, spend: 0, saving: 0, debt: 0, cats: {}, n: 0 }]));
  for (const t of totals.results as { month: string; bucket: string; category: string; cents: number; n: number }[]) {
    const m = byMonth.get(t.month);
    if (!m) continue;
    m.n += t.n;
    if (t.bucket === "income") m.income -= t.cents;
    else if (t.bucket === "spend") { m.spend += t.cents; m.cats[t.category] = (m.cats[t.category] ?? 0) + t.cents; }
    else if (t.bucket === "saving") m.saving += t.cents;
    else if (t.bucket === "debt") m.debt += t.cents;
  }
  const ret = await retirementData(env, owner, { adviceOnly: true });
  const c = cash.results[0] as { checking: number; savings: number };
  const held = holdings.results as { name: string | null; type: string | null; cents: number; taxable: number }[];
  const input: AdviceInput = {
    today: new Date().toISOString().slice(0, 10),
    months: [...byMonth.values()],
    recurring: recurring.results as AdviceInput["recurring"],
    checkingCents: c?.checking ?? 0, savingsCents: c?.savings ?? 0,
    retirement: ret as unknown as AdviceInput["retirement"],
    holdings: held.map(({ name, type, cents }) => ({ name, type, cents })),
    hasBrokerage: held.some((h) => h.taxable) || ret.accounts.some((a) => !a.in_retirement),
    people: owner ? [owner] : [...config.users.keys()],
    labels: Object.fromEntries(config.users),
    checklist: parse((state.results[0] as { value: string } | undefined)?.value),
  };
  return json({ checked: CHECKED, findings: recommend(input), checklist: checklist(input) });
}

/** PUT /audit/checklist {id, checked}: a checklist item ticked today (or unticked). Household-wide. */
export async function setChecklist(env: Env, request: Request): Promise<Response> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  const { id, checked } = b as Record<string, unknown>;
  if (typeof id !== "string" || !CHECKLIST.some((i) => i.id === id)) throw unprocessable("id must be one of the checklist's items");
  if (typeof checked !== "boolean") throw unprocessable("checked must be true or false");
  const checkedOn = checked ? new Date().toISOString().slice(0, 10) : null;
  // Merge only this item atomically: overlapping clicks must not overwrite another item's change.
  // JSON Merge Patch removes the item for null; invalid or non-object legacy state starts empty.
  const row = await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at)
    VALUES (?1, json_patch('{}', json_object(?2, ?3)), ${NOW})
    ON CONFLICT (key) DO UPDATE SET value = json_patch(
      CASE WHEN json_valid(app_state.value) THEN
        CASE WHEN json_type(app_state.value) = 'object' THEN app_state.value ELSE '{}' END
      ELSE '{}' END, json_object(?2, ?3)), updated_at = excluded.updated_at
    RETURNING json_extract(value, '$.' || ?2) AS checked_on`)
    .bind(CHECKLIST_KEY, id, checkedOn).first<{ checked_on: string | null }>();
  return json({ id, checked_on: row!.checked_on });
}
