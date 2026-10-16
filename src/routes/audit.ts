import type { Env } from "../env";
import type { Config } from "../config";
import { HttpError, json, jsonBody, unprocessable } from "../http";
import { markAuditDirty } from "../audit/totals";

/** CFA, the Complete financial audit (docs/cfa.md), phase C2: what the audit's charts show. Reads
 * only what the cron prepared (monthly_totals, net_worth, recurring_charges), never the
 * transactions, so it costs the same however long the history is. The browser draws the charts
 * and works out the findings. */

const BUCKETS = ["income", "spend", "saving", "transfer", "debt"] as const;
const MAX_MERCHANT = 80;

const monthsBack = (n: number, now = new Date()) => {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
};

/** GET /audit?months=12|24&owner=: monthly totals by bucket and category, net worth by day, the
 * recurring charges, card balances and the household's corrections. */
export async function audit(env: Env, config: Config, url: URL): Promise<Response> {
  const n = url.searchParams.get("months") === "24" ? 24 : 12;
  const owner = url.searchParams.get("owner");
  if (owner !== null && !config.users.has(owner)) throw unprocessable("owner must be one of the people in MINTY_USERS");
  const months = monthsBack(n);
  const since = `${months[0]}-01`;
  const by = (col: string) => (owner === null ? "" : ` AND ${col} = ?`);     // the person filter, when there is one
  const who = owner === null ? [] : [owner];
  const [totals, worth, recurring, cards, corrections, state] = await env.DB.batch([
    env.DB.prepare(`SELECT month, bucket, category, sum(amount_cents) AS cents, sum(n) AS n FROM monthly_totals
                    WHERE month >= ?${by("owner")} GROUP BY month, bucket, category`).bind(months[0], ...who),
    env.DB.prepare(`SELECT date, sum(assets_cents) AS assets, sum(debts_cents) AS debts FROM net_worth
                    WHERE date >= ?${by("owner")} GROUP BY date`).bind(since, ...who),
    env.DB.prepare(`SELECT r.owner, r.merchant, r.name, r.category, r.cadence, r.n, r.avg_cents, r.last_cents, r.prev_cents,
                           r.distinct_amounts, r.first_date, r.last_date, o.bucket AS corrected
                    FROM recurring_charges r LEFT JOIN bucket_overrides o ON o.merchant = r.merchant
                    WHERE 1${by("r.owner")}`).bind(...who),
    env.DB.prepare(`SELECT name, mask, owner, balance_current_cents AS balance FROM accounts
                    WHERE type = 'credit'${by("owner")}`).bind(...who),
    env.DB.prepare("SELECT merchant, bucket FROM bucket_overrides"),
    env.DB.prepare("SELECT key, value, updated_at FROM app_state WHERE key IN ('audit_watermark', 'audit_rebuilt_at', 'audit_dirty')"),
  ]);
  const st = Object.fromEntries((state.results as { key: string; value: string | null; updated_at: string }[]).map((r) => [r.key, r]));
  return json({
    today: new Date().toISOString().slice(0, 10),
    months, owner,
    totals: totals.results,
    net_worth: worth.results,
    recurring: recurring.results,
    cards: cards.results,
    corrections: corrections.results,
    refreshed_at: st.audit_watermark?.updated_at ?? null,       // the last cron run that looked
    rebuilt_at: st.audit_rebuilt_at?.value ?? null,
    pending_rebuild: Boolean(st.audit_dirty?.value),           // a correction waiting for the next run
  });
}

/** PUT /audit/buckets {merchant, bucket | null}: a merchant's bucket, corrected (or the correction
 * removed). The totals follow at the next cron run (the 10-minute one, when nothing's syncing). */
export async function setBucket(env: Env, request: Request): Promise<Response> {
  let b: unknown;
  try { b = await jsonBody(request); } catch (e) {
    if (e instanceof HttpError) throw e;
  }
  if (!b || typeof b !== "object" || Array.isArray(b)) throw unprocessable("body must be a JSON object");
  const { merchant, bucket } = b as Record<string, unknown>;
  const m = typeof merchant === "string" ? merchant.replace(/\s+/g, " ").trim().toUpperCase() : "";
  if (!m || m.length > MAX_MERCHANT) throw unprocessable(`merchant must be 1–${MAX_MERCHANT} characters`);
  if (bucket !== null && !(typeof bucket === "string" && (BUCKETS as readonly string[]).includes(bucket))) {
    throw unprocessable(`bucket must be one of ${BUCKETS.join(", ")}, or null to remove the correction`);
  }
  if (bucket === null) await env.DB.prepare("DELETE FROM bucket_overrides WHERE merchant = ?").bind(m).run();
  else await env.DB.prepare(`INSERT INTO bucket_overrides (merchant, bucket) VALUES (?, ?)
                             ON CONFLICT (merchant) DO UPDATE SET bucket = excluded.bucket, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .bind(m, bucket).run();
  await markAuditDirty(env);
  return json({ merchant: m, bucket });
}
