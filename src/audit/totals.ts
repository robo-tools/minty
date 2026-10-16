import type { Env } from "../env";

/** CFA, the Complete financial audit (docs/cfa.md), phase C1: what the audit's charts read, kept
 * by the hourly cron, never on a request.
 *
 * Each posted transaction gets one bucket (all in SQL, so the Worker does no per-row work):
 *  - a correction in bucket_overrides for its merchant, if there is one; else
 *  - a transfer pair (the same amount the other way in another of the household's accounts,
 *    within 3 days, one side of it a Plaid transfer or loan payment): saving when money moves between a spending account and a savings,
 *    investment or HSA account (negative when it comes back out), otherwise transfer (ignored);
 *  - income: INCOME, or TRANSFER_IN from outside into a bank account;
 *  - transfer: a payment arriving on a credit card (the purchases on it already count);
 *  - debt: a loan payment going out (a mortgage, a car loan, a card that isn't linked);
 *  - transfer: anything else inside a savings or investment account;
 *  - spend: everything else (a refund is negative spending). A statement credit (money back
 *    under BANK_FEES, like a card's Uber or hotel credit) is spending under category CREDITS, so
 *    "fees paid" stays the real fees.
 *
 * monthly_totals is refreshed from the month of the earliest transaction added since the last
 * run (3 days earlier, for a transfer's other side), and rebuilt whole once a week, or when a
 * correction changed (app_state audit_dirty), which also catches edits and removals. */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
export const REBUILD_DAYS = 7;
/** Bump when the rules below change: the next run rebuilds every month with the new ones. */
export const RULES_VERSION = "2";

// A pair needs one side Plaid calls a transfer, so a $100 purchase and an unrelated $100 deposit
// in the same week stay what they are.
const TRANSFERS = "('TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS')";

// Each account's type, and whether it's a savings, investment or HSA account, are passed in as two
// small JSON objects keyed by account id (?2, ?3; see accountMaps): joining accounts instead would
// read an account row for every transaction, which D1 counts.
const TYPE = (id: string) => `json_extract(?2, '$."' || ${id} || '"')`;
const SAVING = (id: string) => `coalesce(json_extract(?3, '$."' || ${id} || '"'), 0)`;

/** ?2 and ?3 for CLASSIFIED: { account id: type } and { account id: 1 } for savings-like accounts. */
export async function accountMaps(env: Env): Promise<[string, string]> {
  const { results } = await env.DB.prepare("SELECT id, type, subtype FROM accounts").all<{ id: number; type: string | null; subtype: string | null }>();
  const types: Record<string, string | null> = {}, saving: Record<string, number> = {};
  for (const a of results) {
    types[a.id] = a.type;
    if (a.type === "investment" || (a.type === "depository" && ["savings", "cd", "money market", "hsa"].includes(a.subtype ?? ""))) saving[a.id] = 1;
  }
  return [JSON.stringify(types), JSON.stringify(saving)];
}

/** The bucket of each posted transaction from ?1 (a date) on: id, owner, month, bucket, category,
 * amount_cents. ?2 and ?3 come from accountMaps. */
export const CLASSIFIED = `
  WITH t AS (
    SELECT t.id, t.owner, t.date, t.amount_cents AS amt, coalesce(nullif(t.category, ''), 'OTHER') AS category,
           ${TYPE("t.account_id")} AS atype, ${SAVING("t.account_id")} AS self_saving,
           upper(coalesce(nullif(t.merchant_name, ''), t.name, '')) AS merchant, coalesce(nullif(t.merchant_name, ''), t.name) AS label,
           (SELECT p.account_id FROM transactions p
             WHERE p.amount_cents = -t.amount_cents AND p.date BETWEEN date(t.date, '-3 days') AND date(t.date, '+3 days')
               AND p.account_id <> t.account_id AND p.pending = 0
               AND (t.category IN ${TRANSFERS} OR p.category IN ${TRANSFERS}) LIMIT 1) AS pair_account
    FROM transactions t
    WHERE t.pending = 0 AND t.amount_cents <> 0 AND t.date >= ?1
  )
  SELECT t.id, t.owner, t.date, substr(t.date, 1, 7) AS month, t.merchant, t.label, t.amt AS amount_cents,
    CASE WHEN t.amt < 0 AND t.category = 'BANK_FEES' THEN 'CREDITS' ELSE t.category END AS category,
    CASE
      WHEN o.bucket IS NOT NULL THEN o.bucket
      WHEN t.pair_account IS NOT NULL THEN
        CASE WHEN ${SAVING("t.pair_account")} AND NOT t.self_saving THEN 'saving' ELSE 'transfer' END
      WHEN t.amt < 0 AND t.category = 'INCOME' THEN 'income'
      WHEN t.amt < 0 AND t.category = 'TRANSFER_IN' AND t.atype = 'depository' AND NOT t.self_saving THEN 'income'
      WHEN t.amt < 0 AND t.atype = 'credit' AND t.category IN ('LOAN_PAYMENTS', 'TRANSFER_IN') THEN 'transfer'
      WHEN t.amt > 0 AND t.category = 'LOAN_PAYMENTS' THEN 'debt'
      WHEN t.self_saving THEN 'transfer'
      ELSE 'spend'
    END AS bucket
  FROM t
  LEFT JOIN bucket_overrides o ON o.merchant = t.merchant`;

const REFRESH = [
  "DELETE FROM monthly_totals WHERE month >= substr(?1, 1, 7)",
  `INSERT INTO monthly_totals (month, owner, bucket, category, amount_cents, n)
   SELECT month, owner, bucket, category, sum(amount_cents), count(*) FROM (${CLASSIFIED.replace("t.date >= ?1", "t.date >= substr(?1, 1, 7) || '-01'")})
   GROUP BY month, owner, bucket, category`,
];

// Recurring charges: a merchant's spending in the last 400 days, charged at least 3 times (twice,
// a year apart, for a yearly one) with steady gaps between charges and amounts within a factor of
// 2.5 (a utility bill varies; groceries don't keep a rhythm). Window functions over that year:
// about 9 rows read per transaction (each sort counts again), so only with the weekly rebuild.
const RECURRING = [
  "DELETE FROM recurring_charges",
  `INSERT INTO recurring_charges (owner, merchant, name, category, cadence, n, avg_cents, last_cents, prev_cents, distinct_amounts, first_date, last_date)
   WITH s AS (
     SELECT owner, merchant, label, category, date, amount_cents FROM (${CLASSIFIED})
     WHERE bucket = 'spend' AND amount_cents > 0 AND merchant <> ''
   ), g AS (
     SELECT s.*, julianday(date) - julianday(lag(date) OVER w) AS gap, lag(amount_cents) OVER w AS prev,
            row_number() OVER (PARTITION BY owner, merchant ORDER BY date DESC) AS rn
     FROM s WINDOW w AS (PARTITION BY owner, merchant ORDER BY date)
   ), a AS (
     SELECT owner, merchant, count(*) AS n, avg(gap) AS avg_gap, min(gap) AS min_gap, max(gap) AS max_gap,
            min(amount_cents) AS lo, max(amount_cents) AS hi, avg(amount_cents) AS avg_cents,
            count(DISTINCT amount_cents) AS distinct_amounts, min(date) AS first_date, max(date) AS last_date,
            -- the newest charge, picked in the same pass (a second look at g would compute it again)
            max(CASE WHEN rn = 1 THEN label END) AS label, max(CASE WHEN rn = 1 THEN category END) AS category,
            max(CASE WHEN rn = 1 THEN amount_cents END) AS last_cents, max(CASE WHEN rn = 1 THEN prev END) AS prev_cents
     FROM g GROUP BY owner, merchant
   ), c AS (
     SELECT a.*, CASE
         WHEN n >= 3 AND avg_gap BETWEEN 6 AND 8 AND min_gap >= 5 AND max_gap <= 9 THEN 'weekly'
         WHEN n >= 3 AND avg_gap BETWEEN 26 AND 35 AND min_gap >= 20 AND max_gap <= 40 THEN 'monthly'
         WHEN n >= 3 AND avg_gap BETWEEN 80 AND 100 AND min_gap >= 70 AND max_gap <= 110 THEN 'quarterly'
         WHEN n >= 2 AND avg_gap BETWEEN 350 AND 380 THEN 'yearly' END AS cadence
     FROM a WHERE hi <= 2.5 * lo
   )
   SELECT owner, merchant, label, category, cadence, n, CAST(round(avg_cents) AS INTEGER), last_cents, prev_cents,
          distinct_amounts, first_date, last_date
   FROM c WHERE cadence IS NOT NULL`,
];

const state = async (env: Env) => Object.fromEntries((await env.DB.prepare(
  "SELECT key, value FROM app_state WHERE key IN ('audit_watermark', 'audit_rebuilt_at', 'audit_dirty', 'audit_version')").all<{ key: string; value: string | null }>()).results
  .map((r) => [r.key, r.value]));
const setState = (env: Env, key: string, value: string | null) => env.DB.prepare(
  `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ${NOW}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
  .bind(key, value);

/** A correction changed: the next hourly run rebuilds every month. */
export const markAuditDirty = (env: Env) => setState(env, "audit_dirty", "1").run();

/** The hourly cron's step (and the quiet catch-up run's, so a correction shows within minutes):
 * refreshes monthly_totals where something changed; with the weekly rebuild, recurring charges too. */
export async function refreshTotals(env: Env, now = new Date()): Promise<{ from: string | null; full: boolean; recurring?: boolean }> {
  const s = await state(env);
  const top = (await env.DB.prepare("SELECT max(id) AS id FROM transactions").first<{ id: number | null }>())?.id ?? 0;
  const mark = Number(s.audit_watermark ?? 0);
  const stale = !s.audit_rebuilt_at || Date.parse(s.audit_rebuilt_at) < now.getTime() - REBUILD_DAYS * 864e5;
  let from: string | null = null, full = false;
  if (stale || s.audit_dirty || top < mark || s.audit_version !== RULES_VERSION) {
    from = "0000-01-01"; full = true;               // weekly, after a correction or a rules change, or the transactions were reset
  } else if (top > mark) {
    // The earliest new transaction, 3 days earlier for its other side: only rows added since the last run.
    from = (await env.DB.prepare("SELECT date(min(date), '-3 days') AS d FROM transactions WHERE id > ?").bind(mark).first<{ d: string | null }>())?.d ?? null;
  }
  const recurring = full;
  const writes = [setState(env, "audit_watermark", String(top))];
  if (from || recurring) {
    const [types, saving] = await accountMaps(env);
    if (from) writes.unshift(env.DB.prepare(REFRESH[0]).bind(from), env.DB.prepare(REFRESH[1]).bind(from, types, saving));
    if (recurring) {
      const since = new Date(now.getTime() - 400 * 864e5).toISOString().slice(0, 10);
      writes.push(env.DB.prepare(RECURRING[0]), env.DB.prepare(RECURRING[1]).bind(since, types, saving));
    }
  }
  if (full) writes.push(setState(env, "audit_rebuilt_at", now.toISOString()), setState(env, "audit_dirty", null), setState(env, "audit_version", RULES_VERSION));
  await env.DB.batch(writes);
  return { from, full, ...(recurring ? { recurring: true } : {}) };
}

// Each account's balance today, written only when it's new or changed (a handful of rows an hour).
const SNAPSHOT = `
  INSERT INTO balance_snapshots (account_id, date, current_cents, available_cents)
  SELECT id, date('now'), balance_current_cents, balance_available_cents FROM accounts
  WHERE balance_current_cents IS NOT NULL OR balance_available_cents IS NOT NULL
  ON CONFLICT (account_id, date) DO UPDATE SET current_cents = excluded.current_cents, available_cents = excluded.available_cents
  WHERE balance_snapshots.current_cents IS NOT excluded.current_cents OR balance_snapshots.available_cents IS NOT excluded.available_cents`;

// Net worth per person today, from the same balances: what bank and investment accounts hold,
// and what cards and loans owe. Written only when it changed.
const NET_WORTH = `
  INSERT INTO net_worth (date, owner, assets_cents, debts_cents)
  SELECT date('now'), owner,
         sum(CASE WHEN type IN ('depository', 'investment') THEN coalesce(balance_current_cents, 0) ELSE 0 END),
         sum(CASE WHEN type IN ('credit', 'loan') THEN coalesce(balance_current_cents, 0) ELSE 0 END)
  FROM accounts WHERE true GROUP BY owner
  ON CONFLICT (date, owner) DO UPDATE SET assets_cents = excluded.assets_cents, debts_cents = excluded.debts_cents
  WHERE net_worth.assets_cents IS NOT excluded.assets_cents OR net_worth.debts_cents IS NOT excluded.debts_cents`;

// Older than a year, a snapshot a week (Sundays) is enough for a trend.
const THIN = "DELETE FROM balance_snapshots WHERE date < date('now', '-365 days') AND strftime('%w', date) <> '0'";

/** The hourly cron's step: today's balances; once a day (the first run after midnight UTC), thins old ones. */
export async function snapshotBalances(env: Env, now = new Date()): Promise<number> {
  const [r] = await env.DB.batch([env.DB.prepare(SNAPSHOT), env.DB.prepare(NET_WORTH)]);
  if (now.getUTCHours() === 0) await env.DB.prepare(THIN).run();
  return r.meta.changes ?? 0;
}
