import type { Env } from "../env";
import { type Config, keyState, secretNames } from "../config";
import { fernetDecrypt, fernetEncrypt } from "../fernet";
import { plaidHost } from "../plaid";
import { json } from "../http";
import { bankHealth, bankRows, syncHealth } from "../health";
import { DEFAULT_READ_BUDGET, LIMITERS, readBudget, readsToday } from "../limits";
import { tokenKeys } from "../token-key";

/** GET /status: setup checks for the household, shown on the /add-user page. Behind Access like
 * every API route; reports only whether things are set, never values. */

/** Must list every file in d1/migrations (a test checks this). */
export const EXPECTED_MIGRATIONS = ["0001_init.sql", "0002_sync_pages.sql", "0003_account_owner.sql", "0004_sync_restart.sql", "0005_bank_health.sql", "0006_card_benefits.sql", "0007_read_indexes.sql", "0008_app_state.sql", "0009_link_sessions.sql", "0010_card_statements.sql", "0011_bill_payment_coverage.sql", "0012_card_display_preferences.sql", "0013_history_verification.sql", "0014_upstream_features.sql"];

interface Check { id: string; ok: boolean; level: "error" | "warn"; message: string; fix?: string }

async function tokenKeyWorks(key: string | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    return (await fernetDecrypt(await fernetEncrypt("check", key), key)) === "check";
  } catch {
    return false;
  }
}

export async function status(env: Env, config: Config, email: string): Promise<Response> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  if (email === "dev@localhost") {
    add({ id: "access", ok: false, level: "warn", message: "Cloudflare Access is bypassed (local development)." });
  } else {
    add({ id: "access", ok: true, level: "error", message: `Signed in through Cloudflare Access as ${email}.` });
  }

  // Every admitted login is fully trusted (README, Security model), so say when the Worker accepts
  // whoever Access lets in.
  const allowed = (env.ALLOWED_LOGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  add(allowed.length
    ? { id: "allowed_logins", ok: true, level: "warn", message: `ALLOWED_LOGINS lists ${allowed.length} login${allowed.length === 1 ? "" : "s"}.` }
    : { id: "allowed_logins", ok: false, level: "warn",
        message: "ALLOWED_LOGINS is empty, so anyone your Access policy lets in can use Minty, with full access to every person's data.",
        fix: "Set the variable ALLOWED_LOGINS to the same addresses as your Access policy, comma-separated." });

  const noLimiter = LIMITERS.filter((n) => !env[n]);
  add(noLimiter.length
    ? { id: "rate_limits", ok: false, level: "warn", message: `Rate limits are off (missing ${noLimiter.join(", ")}).`,
        fix: "Sync your fork and redeploy: wrangler.jsonc defines them." }
    : { id: "rate_limits", ok: true, level: "warn", message: "Rate limits are on (per login, per minute)." });

  const { budget, valid } = readBudget(env);
  const used = await readsToday(env.DB).catch(() => 0);
  const fmt = (n: number) => n.toLocaleString("en-US");
  add(!valid
    ? { id: "read_budget", ok: false, level: "error", message: `READ_BUDGET_PER_DAY isn't a whole number, so the default (${fmt(DEFAULT_READ_BUDGET)} rows) is used.`,
        fix: "Set READ_BUDGET_PER_DAY to a whole number of rows (0 = no budget), or delete it." }
    : !budget
    ? { id: "read_budget", ok: true, level: "warn", message: `No daily D1 read budget (READ_BUDGET_PER_DAY is 0). Counted today: ${fmt(used)} rows.` }
    : used > budget
    ? { id: "read_budget", ok: false, level: "warn",
        message: `Today's D1 reads (${fmt(used)} rows counted) passed the daily budget of ${fmt(budget)}: browsing and search pause until 00:00 UTC. Sync keeps running.`,
        fix: "If this happens on a normal day, raise READ_BUDGET_PER_DAY (the free plan allows 5,000,000)." }
    : { id: "read_budget", ok: true, level: "warn", message: `D1 rows read today: ${fmt(used)} counted, of a daily budget of ${fmt(budget)}.` });

  add((await tokenKeyWorks(env.TOKEN_ENC_KEY))
    ? { id: "token_key", ok: true, level: "error", message: "TOKEN_ENC_KEY is set." }
    : { id: "token_key", ok: false, level: "error", message: "TOKEN_ENC_KEY is missing or not a valid key, so banks can't be linked.",
        fix: "Add a secret TOKEN_ENC_KEY. Generate one with: openssl rand -base64 32 | tr '+/' '-_'" });

  // Changing the key (SETUP.md, "Changing the encryption key"): only shown while
  // TOKEN_ENC_KEY_PREVIOUS is set, until every stored token is on the new key.
  if (env.TOKEN_ENC_KEY_PREVIOUS !== undefined) {
    const fixDelete = "Delete the secret TOKEN_ENC_KEY_PREVIOUS (Workers & Pages → minty → Settings → Variables and secrets).";
    if (!(await tokenKeyWorks(env.TOKEN_ENC_KEY_PREVIOUS))) {
      add({ id: "token_key_previous", ok: false, level: "error", message: "TOKEN_ENC_KEY_PREVIOUS isn't a valid key, so it opens nothing.",
            fix: "Set it to the old TOKEN_ENC_KEY exactly as it was, or delete it." });
    } else if (env.TOKEN_ENC_KEY_PREVIOUS.trim() === (env.TOKEN_ENC_KEY ?? "").trim()) {
      add({ id: "token_key_previous", ok: false, level: "warn", message: "TOKEN_ENC_KEY_PREVIOUS is the same as TOKEN_ENC_KEY, so the key isn't being changed.", fix: fixDelete });
    } else {
      const k = await tokenKeys(env);
      const banks = (n: number) => `${n} bank${n === 1 ? "" : "s"}`;
      add(k.previous
        ? { id: "token_key_previous", ok: false, level: "warn",
            message: `Changing the encryption key: ${banks(k.previous)} still on the old key. The hourly sync moves them; keep TOKEN_ENC_KEY_PREVIOUS until this says none are left.` }
        : { id: "token_key_previous", ok: false, level: "warn",
            message: `Every stored bank connection is on the new TOKEN_ENC_KEY${k.neither ? ` (${banks(k.neither)} open with neither key: link ${k.neither === 1 ? "it" : "them"} again)` : ""}. The old key isn't needed any more.`,
            fix: fixDelete });
    }
  }

  let plaidEnv = (env.PLAID_ENV ?? "sandbox").trim() || "sandbox";
  try {
    plaidHost(env);
    add(plaidEnv === "production"
      ? { id: "plaid_env", ok: true, level: "warn", message: "Plaid: production (real banks)." }
      : { id: "plaid_env", ok: false, level: "warn", message: "Plaid: sandbox (test banks only).",
          fix: "Set the variable PLAID_ENV to production when you're ready to link real banks." });
  } catch (e) {
    plaidEnv = "invalid";
    add({ id: "plaid_env", ok: false, level: "error", message: (e as Error).message, fix: "Set PLAID_ENV to sandbox or production." });
  }

  for (const [key, label] of config.users) {
    const accounts = config.ownerAccounts.get(key)!;
    const slotOf = (a: string) => a.slice(a.indexOf("_") + 1);
    const set = accounts.filter((a) => keyState(env, config, a) === "set");
    const partial = accounts.filter((a) => keyState(env, config, a) === "partial");
    if (!set.length) {
      const n = secretNames(accounts[0]);
      add({ id: `plaid_keys_${key}`, ok: false, level: "warn", message: `${label}: no Plaid keys yet, so they can't link banks.`,
            fix: `Add secrets ${n.clientId} and ${n.secret}` +
                 (accounts.length > 1 ? ` (more Plaid accounts go in the next slots: ${accounts.slice(1).map(slotOf).join(", ")}).` : ".") });
    } else {
      const unused = accounts.filter((a) => keyState(env, config, a) === "missing").map(slotOf);
      add({ id: `plaid_keys_${key}`, ok: true, level: "warn",
            message: `${label}: Plaid keys set for ${set.map(slotOf).join(", ")}` +
                     ` (${set.length} of ${accounts.length} slot${accounts.length === 1 ? "" : "s"}, up to ${set.length * config.itemCap} bank logins)` +
                     (unused.length ? `; ${unused.join(", ")} unused.` : ".") });
    }
    for (const a of partial) {                   // half-set keys are a typo, not an unused slot
      const n = secretNames(a);
      add({ id: `plaid_keys_partial_${a}`, ok: false, level: "error",
            message: `${label}: slot ${slotOf(a)} has only one of its two Plaid keys, so it's skipped.`,
            fix: `Set both ${n.clientId} and ${n.secret}, or remove the one that's there.` });
    }
  }

  let applied: string[] = [];
  try {
    applied = (await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map((r) => r.name);
  } catch { /* table missing: nothing applied */ }
  const missing = EXPECTED_MIGRATIONS.filter((m) => !applied.includes(m));
  add(missing.length
    ? { id: "migrations", ok: false, level: "error", message: `Database schema is out of date (missing ${missing.join(", ")}).`,
        fix: "Redeploy (npm run deploy applies migrations), or run: npx wrangler d1 migrations apply DB --remote" }
    : { id: "migrations", ok: true, level: "error", message: "Database schema is up to date." });

  const { results: counts } = await env.DB.prepare("SELECT status, count(*) AS n FROM items GROUP BY status")
    .all<{ status: string; n: number }>().catch(() => ({ results: [] as { status: string; n: number }[] }));
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  // Plaid keys for someone who isn't in MINTY_USERS (e.g. set up for a second person who was never
  // added): they're never used, so say so rather than leave them silently ignored.
  const known = new Set([...config.users.keys()].map((k) => k.toUpperCase()));
  const orphans = [...new Set(Object.keys(env)
    .filter((k) => typeof (env as Record<string, unknown>)[k] === "string" && (env as Record<string, unknown>)[k] !== "")
    .map((k) => /^PLAID_(?:CLIENT_ID|SECRET)_([A-Z][A-Z0-9]*)_[A-Z0-9]+$/.exec(k)?.[1])
    .filter((k): k is string => !!k && !known.has(k)))];
  if (orphans.length) {
    const example = [...[...config.users].map(([k, l]) => `${k}:${l}`), ...orphans.map((o) => `${o.toLowerCase()}:Name`)].join(",");
    add({ id: "keys_unused", ok: false, level: "warn",
          message: `Plaid keys are set for ${orphans.join(", ")}, who ${orphans.length === 1 ? "isn't" : "aren't"} in MINTY_USERS, so they aren't used.`,
          fix: `To add ${orphans.length === 1 ? "them" : "those people"}, set MINTY_USERS to e.g. ${example}. Otherwise delete those secrets.` });
  }

  // Banks whose credential set is gone (person removed from MINTY_USERS, slot removed from
  // PLAID_SLOTS) or has no keys any more: sync skips them, so say so instead of failing silently.
  const { results: perAccount } = await env.DB.prepare(
    "SELECT plaid_account, count(*) AS n FROM items WHERE status IN ('good', 'login_required') GROUP BY plaid_account",
  ).all<{ plaid_account: string; n: number }>().catch(() => ({ results: [] as { plaid_account: string; n: number }[] }));
  const stranded = perAccount.filter((r) => !config.accountOwner.has(r.plaid_account) || keyState(env, config, r.plaid_account) !== "set");
  if (stranded.length) {
    const total = stranded.reduce((t, r) => t + r.n, 0);
    const why = stranded.map((r) => `${r.plaid_account} (${config.accountOwner.has(r.plaid_account)
      ? "no keys" : "not in MINTY_USERS / PLAID_SLOTS"})`).join(", ");
    add({ id: "items_stranded", ok: false, level: "error", message: `${total} bank(s) can't sync: ${why}.`,
          fix: "Restore that person / slot and its keys. Banks stay with the Plaid account they were linked under." });
  }

  // A bank link that stopped after its session was claimed (src/routes/link.ts): Plaid may have
  // created the connection, so it keeps counting against that slot's cap.
  const { results: interrupted } = await env.DB.prepare(
    `SELECT plaid_account, count(*) AS n FROM link_sessions
     WHERE operation = 'link' AND used_at IS NOT NULL AND finished_at IS NULL AND released_at IS NULL
       AND used_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes')
     GROUP BY plaid_account`).all<{ plaid_account: string; n: number }>().catch(() => ({ results: [] as { plaid_account: string; n: number }[] }));
  for (const r of interrupted) {
    add({ id: `link_interrupted_${r.plaid_account}`, ok: false, level: "warn",
          message: `${r.n} bank link${r.n === 1 ? "" : "s"} on ${r.plaid_account} stopped after Plaid may have created the connection, ` +
                   `so ${r.n === 1 ? "it counts" : "they count"} against its ${config.itemCap}-bank cap.`,
          fix: "If a bank you linked is missing from the dashboard, link it again. To stop counting an interrupted link, " +
               "delete its row from link_sessions in the D1 console (only if you're sure Plaid didn't keep that connection)." });
  }

  // Card members (Plaid's account_owner) per bank, so a household can see whether a multi-card
  // account (e.g. Amex authorized-user cards) reports who made each charge. Shown for American
  // Express and for any bank where Plaid sends it. Informational: never a warning, because Plaid
  // fills it in only for some accounts.
  const { results: members } = await env.DB.prepare(
    // Only banks that are Amex or have card members; member counts come from the partial index
    // idx_txn_member, and only those banks' transactions are counted.
    `SELECT i.id, i.institution_name AS name,
            (SELECT count(*) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.item_id = i.id) AS n,
            (SELECT count(*) FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.item_id = i.id AND t.account_owner IS NOT NULL) AS with_member,
            (SELECT count(DISTINCT t.account_owner) FROM transactions t JOIN accounts a ON a.id = t.account_id
              WHERE a.item_id = i.id AND t.account_owner IS NOT NULL) AS distinct_members
     FROM items i
     WHERE i.status IN ('good', 'login_required')
       AND (i.institution_name LIKE 'American Express%' OR EXISTS (
             SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
             WHERE a.item_id = i.id AND t.account_owner IS NOT NULL))
     ORDER BY i.id`,
  ).all<{ id: number; name: string | null; n: number; with_member: number; distinct_members: number }>()
    .catch(() => ({ results: [] as { id: number; name: string | null; n: number; with_member: number; distinct_members: number }[] }));
  for (const m of members) {
    const bank = m.name || `Bank #${m.id}`;
    const txns = `${m.n} transaction${m.n === 1 ? "" : "s"}`;
    add({ id: `card_members_${m.id}`, ok: true, level: "warn",
          message: m.with_member
            ? `${bank}: card member on ${m.with_member} of ${txns} (${m.distinct_members} card member${m.distinct_members === 1 ? "" : "s"}).`
            : `${bank}: no card members on its ${txns} yet. Plaid fills this in only for some accounts, such as Amex authorized-user cards.` });
  }

  // Per bank, the same verdict the dashboard shows (src/health.ts): sign in again, broken,
  // stalled, consent ending soon, or still downloading. Stranded banks are listed above.
  const rows = await bankRows(env).catch(() => []);
  for (const r of rows) {
    const h = bankHealth(env, config, r);
    if (!h.level || h.state === "stranded") continue;
    const detail = [h.detail, h.error_code && `(${h.error_code}${h.plaid_message ? `: ${h.plaid_message}` : ""})`].filter(Boolean).join(" ");
    add({ id: `bank_${h.state}_${r.id}`, ok: h.level === "info", level: h.level === "error" ? "error" : "warn",
          message: [h.message, detail].filter(Boolean).join(" "), ...(h.fix ? { fix: h.fix } : {}) });
  }

  const sync = syncHealth(env, config, rows);
  // Statement details for Bills (docs/bills.md): only the banks that need something. A problem here
  // never stops transaction sync, so these are warnings.
  const statementIssues = await env.DB.prepare(
    `SELECT ss.item_id, ss.status, ss.last_error, i.institution_name FROM liability_sync ss JOIN items i ON i.id = ss.item_id
     WHERE ss.status IN ('consent_required', 'unsupported', 'error') ORDER BY ss.item_id`).all<{ item_id: number; status: string; last_error: string | null; institution_name: string | null }>()
    .then((r) => r.results).catch(() => []);
  for (const r of statementIssues) {
    const bank = r.institution_name ?? "A bank";
    add(r.status === "consent_required"
      ? { id: `statements_${r.item_id}`, ok: false, level: "warn", message: `${bank} needs your consent again for statement details (Bills).`,
          fix: "Open Bills → Statement connections and choose Review statement access for this bank." }
      : r.status === "unsupported"
      ? { id: `statements_${r.item_id}`, ok: false, level: "warn", message: `${bank} doesn't currently share statement details through Plaid.`,
          fix: "Open Bills → Statement connections to review statement access. Saved statements remain available." }
      : { id: `statements_${r.item_id}`, ok: false, level: "warn", message: `${bank}: fetching statement details failed (${r.last_error ?? "error"}). Minty retries every hour.` });
  }
  if (sync) add({ id: "sync", level: "warn", ...sync });

  return json({ backend: "workers", plaid_env: plaidEnv, checks, items: byStatus });
}
