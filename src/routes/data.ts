import { IN_RETIREMENT } from "../investments";
import type { Env } from "../env";
import { type Config, isConfigured } from "../config";
import { HttpError, dateParam, intParam, json, jsonBody, unprocessable } from "../http";
import { bankHealth, bankRows, syncHealth } from "../health";
import { RESERVED } from "./link";

/** Read API for the pages in public/, plus tag editing. */

const MAX_FILTER_TAGS = 20;   // D1 allows 100 bound parameters per query
// Banks + accounts together. Worst case: 60 ids + 20 tags + 1 tag count + owner, start, end,
// 2 for q, and limit = 87 bound parameters, under D1's 100.
const MAX_FILTER_IDS = 60;    // a card member counts as 2 (account id + name)
const MAX_CARD_MEMBER_LENGTH = 200;
const MAX_TAGS_PER_TXN = 50;
const MAX_TAG_LENGTH = 64;
// D1 allows 50 bytes in a LIKE pattern, and the search adds a % on each side: longer text failed
// with "LIKE or GLOB pattern too complex". The dashboard's search box stops there too (maxlength).
export const MAX_SEARCH_BYTES = 48;

export async function users(env: Env, config: Config): Promise<Response> {
  // Reports only whether keys are present, never the keys themselves.
  return json([...config.users].map(([key, label]) => ({
    key,
    label,
    slots: config.ownerAccounts.get(key)!.map((account) => ({
      account,
      slot: account.slice(account.indexOf("_") + 1),
      configured: isConfigured(env, config, account),
    })),
  })));
}

export async function items(env: Env, config: Config): Promise<Response> {
  const now = Date.now();
  return json((await bankRows(env)).map((r) => ({
    id: r.id, owner: r.owner, plaid_account: r.plaid_account, institution_name: r.institution_name,
    status: r.status, updated_at: r.updated_at, health: bankHealth(env, config, r, now),
  })));
}

/** GET /health: what the dashboard's status strip shows. Banks that need attention (or are still
 * downloading), most serious first, plus whether sync runs at all. */
export async function health(env: Env, config: Config): Promise<Response> {
  const now = Date.now();
  const rows = await bankRows(env);
  const rank = { error: 0, warn: 1, info: 2 } as const;
  const banks = rows.map((r) => ({ id: r.id, owner: r.owner, institution_name: r.institution_name, health: bankHealth(env, config, r, now) }))
    .filter((b) => b.health.level)
    .sort((a, b) => rank[a.health.level!] - rank[b.health.level!] || a.id - b.id);
  return json({ sync: syncHealth(env, config, rows, now), banks });
}

export async function accounts(env: Env, url: URL): Promise<Response> {
  const owner = url.searchParams.get("owner");
  // Retirement accounts (EGG) are islanded: left out unless ?view=all, or switched to the dashboard.
  const island = url.searchParams.get("view") === "all" ? "1" : `NOT ${IN_RETIREMENT("accounts")}`;
  const select = `SELECT id, owner, item_id, plaid_account_id, name, mask, type, subtype,
                         balance_current_cents / 100.0 AS balance_current,
                         balance_available_cents / 100.0 AS balance_available,
                         currency, updated_at, ${IN_RETIREMENT("accounts")} AS in_retirement
                  FROM accounts`;
  const stmt = owner
    ? env.DB.prepare(`${select} WHERE owner = ? AND ${island} ORDER BY name`).bind(owner)
    : env.DB.prepare(`${select} WHERE ${island} ORDER BY owner, name`);
  const rows = (await stmt.all<{ id: number }>()).results;
  // Card members (Plaid's account_owner) on multi-card accounts, e.g. Amex authorized-user cards,
  // most-used first. Only accounts that have any; their transactions without one are listed as
  // { name: null } so they can be picked too.
  // Reads only rows that have a card member (SQLite uses the partial index idx_txn_member), then one count per
  // account that has any: scanning every transaction twice on each dashboard load added up.
  const [named, totals] = await env.DB.batch([
    env.DB.prepare(
      `SELECT account_id, account_owner AS name, count(*) AS count FROM transactions
       WHERE account_owner IS NOT NULL GROUP BY account_id, account_owner`),
    env.DB.prepare(
      `SELECT a.account_id, (SELECT count(*) FROM transactions t WHERE t.account_id = a.account_id) AS count
       FROM (SELECT DISTINCT account_id FROM transactions WHERE account_owner IS NOT NULL) a`),
  ]);
  type Member = { account_id: number; name: string | null; count: number };
  const named_ = named.results as unknown as Member[];
  const members: Member[] = [...named_];
  for (const t of totals.results as unknown as { account_id: number; count: number }[]) {
    const withName = named_.filter((m) => m.account_id === t.account_id).reduce((n, m) => n + m.count, 0);
    if (t.count > withName) members.push({ account_id: t.account_id, name: null, count: t.count - withName });
  }
  members.sort((a, z) => a.account_id - z.account_id || Number(a.name === null) - Number(z.name === null) || z.count - a.count
    || (a.name ?? "").localeCompare(z.name ?? ""));
  return json(rows.map((a) => ({
    ...a,
    card_members: members.filter((m) => m.account_id === a.id).map(({ name, count }) => ({ name, count })),
  })));
}

export async function capacity(env: Env, config: Config): Promise<Response> {
  // Per-person Trial-account usage: how many Items each credential set holds vs the cap.
  const [itemsRes, reservedRes] = await env.DB.batch([
    env.DB.prepare("SELECT plaid_account, count(*) AS n FROM items GROUP BY plaid_account"),
    // Link sessions holding a slot (src/routes/link.ts): being linked right now, or interrupted
    env.DB.prepare(`SELECT plaid_account, count(*) AS n FROM link_sessions s WHERE ${RESERVED} GROUP BY plaid_account`),
  ]);
  const counts = new Map((itemsRes.results as { plaid_account: string; n: number }[]).map((r) => [r.plaid_account, r.n]));
  const reserved = new Map((reservedRes.results as { plaid_account: string; n: number }[]).map((r) => [r.plaid_account, r.n]));
  const out: Record<string, unknown[]> = {};
  for (const [owner, keys] of config.ownerAccounts) {
    out[owner] = keys.map((k) => ({
      account: k,
      slot: k.slice(k.indexOf("_") + 1),
      used: counts.get(k) ?? 0,
      reserved: reserved.get(k) ?? 0,
      cap: config.itemCap,
      configured: isConfigured(env, config, k),       // slots without keys are skipped when linking
    }));
  }
  return json(out);
}

/** Trim, drop blanks, dedupe case-insensitively keeping the first spelling. */
export function normaliseTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      clean.push(t);
    }
  }
  return clean;
}

/** Repeatable positive-integer query param (item_id, account_id), de-duplicated. */
function idList(p: URLSearchParams, name: string): number[] {
  const raw = p.getAll(name).filter((s) => s !== "");
  if (raw.some((s) => !/^\d+$/.test(s))) throw unprocessable(`${name} must be an integer`);
  return [...new Set(raw.map(Number))];
}

const marks = (xs: unknown[]) => xs.map(() => "?").join(", ");

/** card (repeatable): "<account_id>:<card member>", one card member on a multi-card account
 * (Plaid's account_owner). An empty member means that account's transactions without one. */
function cardList(p: URLSearchParams): { accountId: number; member: string | null }[] {
  const seen = new Set<string>();
  const out: { accountId: number; member: string | null }[] = [];
  for (const raw of p.getAll("card")) {
    if (raw === "") continue;
    const m = /^(\d+):([\s\S]*)$/.exec(raw);
    if (!m) throw unprocessable("card must be <account_id>:<card member>");
    if (m[2].length > MAX_CARD_MEMBER_LENGTH) throw unprocessable(`card member must be at most ${MAX_CARD_MEMBER_LENGTH} characters`);
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ accountId: Number(m[1]), member: m[2] === "" ? null : m[2] });
  }
  return out;
}

interface TxnRow {
  pending: number;
  tags: string;
  [k: string]: unknown;
}

export async function transactions(env: Env, url: URL): Promise<Response> {
  const p = url.searchParams;
  const owner = p.get("owner") || undefined;
  const start = dateParam(url, "start");
  const end = dateParam(url, "end");
  const q = p.get("q") || undefined;
  if (q && new TextEncoder().encode(q).length > MAX_SEARCH_BYTES) {
    throw unprocessable(`search text must be at most ${MAX_SEARCH_BYTES} characters (fewer with accents or emoji)`);
  }
  const tags = normaliseTags(p.getAll("tag"));
  const tagMode = p.get("tag_mode") ?? "any";
  if (tagMode !== "any" && tagMode !== "all") throw unprocessable("tag_mode must be 'any' or 'all'");
  if (tags.length > MAX_FILTER_TAGS) throw unprocessable(`at most ${MAX_FILTER_TAGS} tags can be filtered on`);
  // item_id (repeatable): a linked bank login. account_id (repeatable): a whole account or card;
  // card (repeatable): one card member on an account. Accounts and card members are one choice
  // (any of them matches); banks AND with that, and with every other filter.
  const banks = idList(p, "item_id");
  const accountIds = idList(p, "account_id");
  const cards = cardList(p);
  if (banks.length + accountIds.length + 2 * cards.length > MAX_FILTER_IDS) {
    throw unprocessable(`at most ${MAX_FILTER_IDS} banks, accounts and card members can be filtered on together ` +
                        "(a card member counts as 2)");
  }
  const limit = intParam(url, "limit", { def: 500, min: 1, max: 1000 })!;

  // Retirement accounts' transactions (an HSA's, say) show in EGG, not here, unless switched back.
  const clauses: string[] = [`NOT ${IN_RETIREMENT("a")}`];
  const params: unknown[] = [];
  if (owner)                   { clauses.push("t.owner = ?");      params.push(owner); }
  if (accountIds.length || cards.length) {
    const any: string[] = [];
    if (accountIds.length) { any.push(`t.account_id IN (${marks(accountIds)})`); params.push(...accountIds); }
    for (const c of cards) {
      if (c.member === null) { any.push("(t.account_id = ? AND t.account_owner IS NULL)"); params.push(c.accountId); }
      else { any.push("(t.account_id = ? AND t.account_owner = ?)"); params.push(c.accountId, c.member); }
    }
    clauses.push(`(${any.join(" OR ")})`);
  }
  if (banks.length)             { clauses.push(`a.item_id IN (${marks(banks)})`); params.push(...banks); }
  if (start)                   { clauses.push("t.date >= ?");      params.push(start); }
  if (end)                     { clauses.push("t.date <= ?");      params.push(end); }
  // before=<date>:<id>: the page after the last row shown (newest first), read through idx_txn_date_id
  const before = url.searchParams.get("before");
  if (before) {
    const m = /^(\d{4}-\d{2}-\d{2}):(\d+)$/.exec(before);
    if (!m) throw unprocessable("before must be <YYYY-MM-DD>:<transaction id>");
    // "date <= ?" lets SQLite range over the index; an OR here made it scan every transaction
    clauses.push("t.date <= ?", "NOT (t.date = ? AND t.id >= ?)"); params.push(m[1], m[1], Number(m[2]));
  }
  if (tags.length) {
    // transaction_tags.tag is COLLATE NOCASE, so IN matches case-insensitively; the
    // (transaction_id, tag) primary key means "all" is a plain count of matching rows.
    const marks = tags.map(() => "?").join(", ");
    clauses.push(tagMode === "any"
      ? `EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag IN (${marks}))`
      : `(SELECT count(*) FROM transaction_tags tt WHERE tt.transaction_id = t.id AND tt.tag IN (${marks})) = ?`);
    params.push(...tags);
    if (tagMode === "all") params.push(tags.length);
  }
  if (q) {
    clauses.push("(t.name LIKE ? OR t.merchant_name LIKE ?)");   // LIKE is case-insensitive for ASCII
    params.push(`%${q}%`, `%${q}%`);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  params.push(limit);

  const sql = `
    SELECT t.id, t.owner, t.account_id, t.plaid_txn_id,
           t.amount_cents / 100.0 AS amount,
           t.currency, t.date, t.datetime, t.name, t.merchant_name, t.category,
           t.pending, t.pending_txn_id, t.account_owner,
           (SELECT json_group_array(tag) FROM
              (SELECT tag FROM transaction_tags tt WHERE tt.transaction_id = t.id ORDER BY tt.position)) AS tags,
           a.name    AS account_name,
           a.mask    AS account_mask,
           a.type    AS account_type,
           a.subtype AS account_subtype,
           a.item_id,
           i.institution_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    JOIN items i ON i.id = a.item_id
    ${where}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...params).all<TxnRow>();
  return json(results.map((r) => ({ ...r, pending: Boolean(r.pending), tags: JSON.parse(r.tags) as string[] })));
}

export async function listTags(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT tag FROM transaction_tags GROUP BY tag ORDER BY tag",
  ).all<{ tag: string }>();
  return json(results.map((r) => r.tag));
}

export async function setTags(env: Env, request: Request, txnId: number): Promise<Response> {
  let body: unknown;
  try {
    body = await jsonBody(request);
  } catch (e) {
    if (e instanceof HttpError) throw e;          // too large
    throw unprocessable("body must be JSON: {\"tags\": [...]}");
  }
  const tags = (body as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
    throw unprocessable("tags must be a list of strings");
  }
  const clean = normaliseTags(tags);
  if (clean.length > MAX_TAGS_PER_TXN) throw unprocessable(`at most ${MAX_TAGS_PER_TXN} tags per transaction`);
  if (clean.some((t) => t.length > MAX_TAG_LENGTH)) throw unprocessable(`tags must be at most ${MAX_TAG_LENGTH} characters`);

  const exists = await env.DB.prepare("SELECT id FROM transactions WHERE id = ?").bind(txnId).first();
  if (!exists) throw new HttpError(404, "transaction not found");

  // One batch = one transaction: replace the row's tags atomically.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM transaction_tags WHERE transaction_id = ?").bind(txnId),
    ...clean.map((tag, i) =>
      env.DB.prepare("INSERT INTO transaction_tags (transaction_id, tag, position) VALUES (?, ?, ?)").bind(txnId, tag, i)),
  ]);
  return json({ id: txnId, tags: clean });
}
