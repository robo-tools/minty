import type { Env } from "./env";
import { type Config, credsFor, isConfigured } from "./config";
import { openAccessToken } from "./token-key";
import { plaidPost, plaidPostText } from "./plaid";
import { classifyPayment, type PaymentTransaction } from "./statement-payments";

/** A bounded, read-only comparison against the history Plaid currently makes available. It does
 * not reset /sync, request older bank history, or claim issuer-confirmed payment allocation.
 * One request checks at most 100 records. Only the separately recorded verified interval changes. */
export const HISTORY_VERIFY_PAGE_SIZE = 100;
const MAX_AGE_MS = 30 * 3.6e6;
const MAX_RUN_MS = 15 * 60_000;
const LEASE_MS = 120_000;
const PAGE = "(SELECT body FROM history_verification_pages WHERE item_id=?1)";
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface HistoryVerificationResult {
  status: "complete" | "partial" | "busy" | "needs_sync" | "retry" | "unavailable";
  code: string;
  checked: number;
  total: number | null;
  from_date: string | null;
  to_date: string | null;
}
interface Item {
  id: number; owner: string; plaid_account: string; plaid_item_id: string; access_token_enc: string;
  txn_cursor: string | null; sync_start_cursor: string | null; status: string; updated_at: string;
  transactions_update_status: string | null; transactions_history_start_date: string | null;
  transactions_verified_start_date: string | null; transactions_verified_end_date: string | null;
  consent_expires_at: string | null;
}
interface Run {
  item_id: number; run_id: string; from_date: string; to_date: string; captured_cursor: string;
  captured_updated_at: string; captured_accounts: string; source_updated_at: string | null; total_count: number | null;
  checked_count: number; created_at: number; expires_at: number; lease_token: string | null;
  lease_expires_at: number | null; status: "active" | "complete" | "failed";
}
interface PageInfo {
  code: string | null; count: number; total: number; ids: string;
  legacy: string;
}
const result = (status: HistoryVerificationResult["status"], code: string, run?: Run | null): HistoryVerificationResult => ({
  status, code, checked: run?.checked_count ?? 0, total: run?.total_count ?? null,
  from_date: run?.from_date ?? null, to_date: run?.to_date ?? null,
});
const validDate = (value: string | null): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const fresh = (value: unknown, now: number): value is string => typeof value === "string" &&
  Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 60_000 && now - Date.parse(value) <= MAX_AGE_MS;
const healthy = (item: Item, now: number) => item.status === "good" && !!item.txn_cursor &&
  item.sync_start_cursor === null && item.transactions_update_status === "HISTORICAL_UPDATE_COMPLETE" &&
  fresh(item.updated_at, now) && (!item.consent_expires_at || Date.parse(item.consent_expires_at) > now);

// Everything that can change the compared data is rechecked in the same transaction that saves
// progress or grants coverage. A lease also prevents concurrent browser requests sharing offsets.
const LIVE_GUARD = `EXISTS (SELECT 1 FROM items i WHERE i.id=v.item_id AND i.owner=?4
  AND i.txn_cursor=v.captured_cursor AND i.updated_at=v.captured_updated_at
  AND i.sync_start_cursor IS NULL AND i.transactions_update_status='HISTORICAL_UPDATE_COMPLETE'
  AND i.status='good' AND julianday(i.updated_at)>=julianday('now','-30 hours')
  AND (i.consent_expires_at IS NULL OR julianday(i.consent_expires_at)>julianday('now')))
  AND v.captured_accounts=(SELECT json_group_array(json_array(plaid_account_id,owner,type,subtype))
    FROM (SELECT plaid_account_id,owner,type,subtype FROM accounts WHERE item_id=v.item_id ORDER BY plaid_account_id))`;
const RUN_GUARD = `v.item_id=?1 AND v.run_id=?2 AND v.lease_token=?3 AND v.status='active'
  AND v.expires_at>?5 AND v.lease_expires_at>?5 AND ${LIVE_GUARD}`;

/** SQL does the large JSON parsing and all exact row comparisons, as in syncItem. The Worker
 * receives only IDs, counts and small legacy classification candidates, never full source pages. */
const INSPECT_PAGE = `WITH
  p AS (SELECT body FROM history_verification_pages WHERE item_id=?1),
  requested AS (SELECT value->>0 AS id,value->>1 AS owner,value->>2 AS type FROM json_each(?7)),
  source AS (SELECT j.value AS raw, j.value->>'transaction_id' AS id,
      j.value->>'account_id' AS aid FROM p,json_each(p.body,'$.transactions') j),
  matched AS (SELECT s.*,a.id AS local_account,t.id AS local_id,t.owner AS local_owner,
    t.amount_cents,t.currency,t.date,t.name,t.merchant_name,t.pending,
    t.category,t.category_detailed,t.category_confidence
    FROM source s LEFT JOIN accounts a ON a.plaid_account_id=s.aid AND a.item_id=?1 AND s.aid IN (SELECT id FROM requested)
      AND a.owner=?2 LEFT JOIN transactions t ON t.plaid_txn_id=s.id AND t.account_id=a.id)
  SELECT CASE
    WHEN json_type(p.body,'$.transactions') IS NOT 'array' OR json_type(p.body,'$.accounts') IS NOT 'array'
      OR json_type(p.body,'$.total_transactions') IS NOT 'integer' OR p.body->>'total_transactions'<0
      THEN 'HISTORY_PAGE_INVALID'
    WHEN p.body->>'$.item.item_id' IS NOT ?3 THEN 'HISTORY_ITEM_MISMATCH'
    WHEN json_type(p.body,'$.item.error') IS NOT 'null' THEN 'HISTORY_ITEM_ERROR'
    WHEN EXISTS (SELECT 1 FROM json_each(p.body,'$.accounts') a WHERE
      json_type(a.value,'$.account_id') IS NOT 'text' OR a.value->>'account_id'='')
      THEN 'HISTORY_SOURCE_ACCOUNT_INVALID'
    WHEN EXISTS (SELECT 1 FROM json_each(p.body,'$.accounts') a JOIN accounts local
      ON local.item_id=?1 AND local.plaid_account_id=a.value->>'account_id'
      WHERE local.plaid_account_id IN (SELECT id FROM requested) AND local.owner IS NOT ?2)
      THEN 'HISTORY_ACCOUNT_OWNER_CHANGED'
    WHEN EXISTS (SELECT 1 FROM requested a WHERE a.type='credit' AND NOT EXISTS
      (SELECT 1 FROM json_each(p.body,'$.accounts') s WHERE s.value->>'account_id'=a.id))
      THEN 'HISTORY_SAVED_CREDIT_ACCOUNT_MISSING'
    WHEN (SELECT count(*) FROM source)!=(SELECT count(DISTINCT id) FROM source)
      OR EXISTS (SELECT 1 FROM source t JOIN history_verification_seen seen ON seen.plaid_txn_id=t.id
        WHERE seen.item_id=?1 AND seen.run_id=?6) THEN 'HISTORY_DUPLICATE_TRANSACTIONS'
    ELSE (SELECT code FROM (SELECT CASE
      WHEN t.aid NOT IN (SELECT id FROM requested) THEN 'HISTORY_UNREQUESTED_TRANSACTION'
      WHEN t.local_id IS NULL THEN 'HISTORY_TRANSACTION_MISSING'
      WHEN t.local_owner IS NOT ?2 THEN 'HISTORY_TRANSACTION_OWNER_CHANGED'
      WHEN json_type(t.raw,'$.transaction_id') IS NOT 'text' OR json_type(t.raw,'$.account_id') IS NOT 'text'
        OR coalesce(json_type(t.raw,'$.amount'),'') NOT IN ('integer','real')
        OR abs((t.raw->>'amount')*100)>9007199254740991
        OR coalesce(json_type(t.raw,'$.pending'),'') NOT IN ('true','false') THEN 'HISTORY_TRANSACTION_INVALID'
      WHEN t.amount_cents IS NOT CAST(round((t.raw->>'amount')*100) AS INTEGER) THEN 'HISTORY_AMOUNT_CHANGED'
      WHEN t.currency IS NOT (t.raw->>'iso_currency_code') THEN 'HISTORY_CURRENCY_CHANGED'
      WHEN t.date IS NOT (t.raw->>'date') OR t.date IS NULL OR date(t.date,'+0 days') IS NOT t.date OR t.date<?4 OR t.date>?5
        THEN 'HISTORY_DATE_CHANGED'
      WHEN t.name IS NOT (t.raw->>'name') THEN 'HISTORY_NAME_CHANGED'
      WHEN t.merchant_name IS NOT (t.raw->>'merchant_name') THEN 'HISTORY_MERCHANT_CHANGED'
      WHEN t.pending IS NOT (t.raw->>'pending') THEN 'HISTORY_PENDING_CHANGED'
      WHEN (t.category IS NOT NULL AND t.category IS NOT (t.raw->>'$.personal_finance_category.primary'))
        OR (t.category_detailed IS NOT NULL AND t.category_detailed IS NOT (t.raw->>'$.personal_finance_category.detailed'))
        OR (t.category_confidence IS NOT NULL AND t.category_confidence IS NOT (t.raw->>'$.personal_finance_category.confidence_level'))
        THEN 'HISTORY_CLASSIFICATION_CHANGED'
      END AS code FROM matched t) WHERE code IS NOT NULL LIMIT 1)
    END AS code,
  (SELECT count(*) FROM source) AS count,p.body->>'total_transactions' AS total,
  (SELECT json_group_array(id) FROM source) AS ids,
  (SELECT json_group_array(json_object('id',t.id,'amount_cents',t.amount_cents,'currency',t.currency,
      'date',t.date,'name',t.name,'merchant_name',t.merchant_name,'pending',t.pending,
      'category',t.category,'category_detailed',t.category_detailed,'category_confidence',t.category_confidence,
      'remote_category',t.raw->>'$.personal_finance_category.primary',
      'remote_detailed',t.raw->>'$.personal_finance_category.detailed',
      'remote_confidence',t.raw->>'$.personal_finance_category.confidence_level'))
    FROM matched t WHERE t.amount_cents<0 AND (t.category IS NULL OR t.category_detailed IS NULL OR t.category_confidence IS NULL)) AS legacy
  FROM p`;

type SourceMarker = { marker: string; code?: never } | { marker?: never; code:
  "SOURCE_ITEM_MISMATCH" | "SOURCE_ITEM_ERROR" | "SOURCE_ITEM_STATUS_MISSING" |
  "SOURCE_MARKER_MISSING" | "SOURCE_MARKER_INVALID" | "SOURCE_MARKER_FUTURE" | "SOURCE_MARKER_STALE" |
  "SOURCE_FAILURE_MARKER_INVALID" | "SOURCE_UPDATE_FAILED" };

async function sourceMarker(env: Env, creds: ReturnType<typeof credsFor>, token: string, item: Item): Promise<SourceMarker> {
  const { body } = await plaidPost<{ item?: { item_id?: string; error?: unknown }; status?: { transactions?: { last_successful_update?: unknown; last_failed_update?: unknown } } }>(
    env, creds, "/item/get", { access_token: token });
  // /item/get's status is at the response root (not inside item).
  if (body.item?.item_id !== item.plaid_item_id) return { code: "SOURCE_ITEM_MISMATCH" };
  if (body.item.error === undefined) return { code: "SOURCE_ITEM_STATUS_MISSING" };
  if (body.item.error !== null) return { code: "SOURCE_ITEM_ERROR" };
  const marker = body.status?.transactions?.last_successful_update;
  if (marker === null || marker === undefined) return { code: "SOURCE_MARKER_MISSING" };
  if (typeof marker !== "string" || !Number.isFinite(Date.parse(marker))) return { code: "SOURCE_MARKER_INVALID" };
  const now = Date.now(), stamp = Date.parse(marker);
  if (stamp > now + 60_000) return { code: "SOURCE_MARKER_FUTURE" };
  if (now - stamp > MAX_AGE_MS) return { code: "SOURCE_MARKER_STALE" };
  const failed = body.status?.transactions?.last_failed_update;
  if (failed !== null && failed !== undefined) {
    if (typeof failed !== "string" || !Number.isFinite(Date.parse(failed))) return { code: "SOURCE_FAILURE_MARKER_INVALID" };
    if (Date.parse(failed) >= stamp) return { code: "SOURCE_UPDATE_FAILED" };
  }
  return { marker };
}

/** Advance (or start) one verification page. Owner filtering must also be enforced by the route;
 * it is repeated here so an internal caller cannot accidentally verify another person's Item. */
export async function verifyHistoryPage(env: Env, config: Config, itemId: number, owner: string | null = null): Promise<HistoryVerificationResult> {
  if (!Number.isSafeInteger(itemId) || itemId < 1) return result("unavailable", "ITEM_UNAVAILABLE");
  const item = await env.DB.prepare("SELECT * FROM items WHERE id=?1 AND (?2 IS NULL OR owner=?2)").bind(itemId, owner).first<Item>();
  if (!item || config.accountOwner.get(item.plaid_account) !== item.owner || !isConfigured(env, config, item.plaid_account) || !env.TOKEN_ENC_KEY)
    return result("unavailable", "ITEM_UNAVAILABLE");
  const now = Date.now();
  if (!healthy(item, now)) return result("needs_sync", "TRANSACTIONS_NOT_READY");
  const dates = (await env.DB.prepare("SELECT statement_issue_date FROM card_liabilities WHERE item_id=? AND available=1")
    .bind(itemId).all<{ statement_issue_date: string | null }>()).results.map(r => r.statement_issue_date).filter(validDate).sort();
  const from = dates[0], to = new Date(now).toISOString().slice(0, 10);
  if (!from || from > to || Date.parse(to) - Date.parse(from) > 730 * 8.64e7) return result("unavailable", "STATEMENT_WINDOW_UNAVAILABLE");
  if (validDate(item.transactions_history_start_date) && item.transactions_history_start_date <= from)
    return { ...result("complete", "ALREADY_COVERED"), from_date: from, to_date: to };

  let run = await env.DB.prepare("SELECT * FROM history_verifications WHERE item_id=?").bind(itemId).first<Run>();
  if (run && run.status === "active" && run.expires_at <= now) {
    await env.DB.prepare("DELETE FROM history_verifications WHERE item_id=? AND expires_at<=?").bind(itemId, now).run();
    return result("retry", "VERIFICATION_EXPIRED", run);
  }
  if (run && run.status !== "active") {
    await env.DB.prepare("DELETE FROM history_verifications WHERE item_id=? AND status!='active'").bind(itemId).run();
    run = null;
  }
  const lease = crypto.randomUUID();
  const runId = run?.run_id ?? crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO history_verifications
      (item_id,run_id,from_date,to_date,captured_cursor,captured_updated_at,created_at,expires_at,captured_accounts)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,(SELECT json_group_array(json_array(plaid_account_id,owner,type,subtype))
        FROM (SELECT plaid_account_id,owner,type,subtype FROM accounts WHERE item_id=?1 ORDER BY plaid_account_id)))`)
      .bind(itemId, runId, from, to, item.txn_cursor, item.updated_at, now, now + MAX_RUN_MS),
    env.DB.prepare(`UPDATE history_verifications SET lease_token=?,lease_expires_at=?
      WHERE item_id=? AND status='active' AND expires_at>? AND (lease_token IS NULL OR lease_expires_at<=?)`)
      .bind(lease, now + LEASE_MS, itemId, now, now),
  ]);
  run = await env.DB.prepare("SELECT * FROM history_verifications WHERE item_id=?").bind(itemId).first<Run>();
  if (!run || run.lease_token !== lease) return result("busy", "VERIFICATION_IN_PROGRESS", run);
  const fail = async (status: "retry" | "needs_sync", code: string) => {
    await env.DB.prepare(`UPDATE history_verifications SET status='failed',failure_code=?,lease_token=NULL,lease_expires_at=NULL
      WHERE item_id=? AND run_id=? AND lease_token=?`).bind(code, itemId, run!.run_id, lease).run();
    return result(status, code, run);
  };
  try {
    if (run.captured_cursor !== item.txn_cursor || run.captured_updated_at !== item.updated_at || run.from_date !== from || run.to_date !== to)
      return await fail("needs_sync", "LOCAL_DATA_CHANGED");
    const capturedAccounts = JSON.parse(run.captured_accounts) as [string, string, string | null, string | null][];
    if (!capturedAccounts.length || capturedAccounts.some(a => typeof a[0] !== "string" || !a[0]))
      return await fail("needs_sync", "HISTORY_SOURCE_ACCOUNT_INVALID");
    if (capturedAccounts.some(a => a[1] !== item.owner)) return await fail("needs_sync", "HISTORY_ACCOUNT_OWNER_CHANGED");
    // Freeze the requested account set across all pages. Plaid may include unrelated account
    // metadata, but no transaction outside this set can establish coverage for these accounts.
    const accountIds = capturedAccounts.map(a => a[0]);
    const creds = credsFor(env, config, item.plaid_account);
    const token = await openAccessToken(env, item);
    const before = await sourceMarker(env, creds, token, item);
    if (before.code) return await fail("needs_sync", before.code);
    if (run.source_updated_at !== null && before.marker !== run.source_updated_at) return await fail("retry", "SOURCE_CHANGED");
    const page = await plaidPostText(env, creds, "/transactions/get", { access_token: token,
      start_date: run.from_date, end_date: run.to_date,
      options: { count: HISTORY_VERIFY_PAGE_SIZE, offset: run.checked_count, account_ids: accountIds } });
    const checks = await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO history_verification_pages(item_id,body)
        SELECT ?1,?2 WHERE json_valid(?2)`).bind(itemId, page),
      env.DB.prepare(INSPECT_PAGE).bind(itemId, item.owner, item.plaid_item_id, run.from_date, run.to_date, run.run_id, run.captured_accounts),
      env.DB.prepare("DELETE FROM history_verification_pages WHERE item_id=?").bind(itemId),
    ]);
    const info = checks[1].results[0] as unknown as PageInfo | undefined;
    if (!info) return await fail("needs_sync", "HISTORY_PAGE_INVALID");
    if (info.code) return await fail("needs_sync", info.code);
    if (!Number.isSafeInteger(info.total) || info.total < 0 || info.count > HISTORY_VERIFY_PAGE_SIZE || run.checked_count + info.count > info.total)
      return await fail("needs_sync", "HISTORY_PAGE_INVALID");
    if (run.total_count !== null && info.total !== run.total_count) return await fail("needs_sync", "HISTORY_TOTAL_CHANGED");
    if (info.count === 0 && run.checked_count < info.total) return await fail("needs_sync", "HISTORY_PAGE_MISSING");
    const legacy = JSON.parse(info.legacy) as (PaymentTransaction & { remote_category: string | null; remote_detailed: string | null; remote_confidence: string | null })[];
    if (legacy.some(t => {
      const local = classifyPayment(t), remote = classifyPayment({ ...t,
        category: t.remote_category, category_detailed: t.remote_detailed, category_confidence: t.remote_confidence });
      return !!local !== !!remote || (local?.evidence === "strong" && remote?.evidence === "likely");
    }))
      return await fail("needs_sync", "PAYMENT_CLASSIFICATION_CHANGED");
    const after = await sourceMarker(env, creds, token, item);
    if (after.code) return await fail("needs_sync", after.code);
    if (after.marker !== before.marker) return await fail("retry", "SOURCE_CHANGED");
    const checked = run.checked_count + info.count, complete = checked === info.total;
    const at = Date.now();
    const params = [itemId, run.run_id, lease, item.owner, at];
    const finalGuard = `v.checked_count=v.total_count
      AND v.checked_count=(SELECT count(*) FROM history_verification_seen s WHERE s.item_id=v.item_id AND s.run_id=v.run_id)
      AND v.checked_count=(SELECT count(*) FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE a.item_id=v.item_id AND a.plaid_account_id IN (SELECT value->>0 FROM json_each(v.captured_accounts))
        AND t.date>=v.from_date AND t.date<=v.to_date)
      AND NOT EXISTS (SELECT 1 FROM transactions t JOIN accounts a ON a.id=t.account_id
        WHERE a.item_id=v.item_id AND a.plaid_account_id IN (SELECT value->>0 FROM json_each(v.captured_accounts))
        AND t.date>=v.from_date AND t.date<=v.to_date AND NOT EXISTS
        (SELECT 1 FROM history_verification_seen s WHERE s.item_id=v.item_id AND s.run_id=v.run_id AND s.plaid_txn_id=t.plaid_txn_id))`;
    const saved = await env.DB.batch([
      env.DB.prepare(`INSERT INTO history_verification_seen(item_id,run_id,plaid_txn_id)
        SELECT v.item_id,v.run_id,j.value FROM history_verifications v,json_each(?6) j WHERE ${RUN_GUARD}`)
        .bind(...params, info.ids),
      env.DB.prepare(`UPDATE history_verifications AS v SET checked_count=?6,total_count=?7,source_updated_at=?8
        WHERE ${RUN_GUARD}`).bind(...params, checked, info.total, before.marker),
      env.DB.prepare(`UPDATE items SET transactions_verified_start_date=?6,transactions_verified_end_date=?8,transactions_verified_at=${NOW}
        WHERE id=?1 AND ?7=1 AND EXISTS (SELECT 1 FROM history_verifications v WHERE ${RUN_GUARD} AND ${finalGuard})`)
        .bind(...params, run.from_date, complete ? 1 : 0, run.to_date),
      env.DB.prepare(`UPDATE history_verifications AS v SET status='complete',completed_at=${NOW}
        WHERE ${RUN_GUARD} AND ?6=1 AND ${finalGuard}`).bind(...params, complete ? 1 : 0),
      env.DB.prepare(`UPDATE history_verifications SET status='failed',failure_code='LOCAL_DATA_CHANGED'
        WHERE item_id=?1 AND run_id=?2 AND lease_token=?3 AND status='active'
        AND (checked_count!=?4 OR ?5=1)`).bind(itemId, run.run_id, lease, checked, complete ? 1 : 0),
      env.DB.prepare("SELECT status,checked_count FROM history_verifications WHERE item_id=? AND run_id=? AND lease_token=?")
        .bind(itemId, run.run_id, lease),
      env.DB.prepare("UPDATE history_verifications SET lease_token=NULL,lease_expires_at=NULL WHERE item_id=? AND run_id=? AND lease_token=?")
        .bind(itemId, run.run_id, lease),
    ]);
    const progress = saved[5].results[0] as { status: string; checked_count: number } | undefined;
    if (!progress || progress.checked_count !== checked || (complete && progress.status !== "complete")) {
      return result("needs_sync", "LOCAL_DATA_CHANGED", run);
    }
    return result(complete ? "complete" : "partial", complete ? "HISTORY_VERIFIED" : "PAGE_VERIFIED",
      { ...run, checked_count: checked, total_count: info.total });
  } catch {
    // Source errors, decryption errors and DB failures never alter a prior coverage boundary.
    return await fail("retry", "VERIFICATION_FAILED");
  }
}
