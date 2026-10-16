import type { Env } from "./env";
import { type Config, keyState } from "./config";

/** Bank health: one verdict per bank (Plaid Item), shared by the dashboard (/items, /health) and
 * Setup checks (/status), so they always say the same thing. Nothing here calls Plaid; it reads
 * what sync and the daily connection check (src/sync.ts) recorded on the item. */

export const STALE_SYNC_HOURS = 3;        // cron runs hourly; allow a couple of misses
export const CONSENT_WARN_DAYS = 7;       // warn this long before a bank's consent through Plaid ends

export type HealthState = "ok" | "downloading" | "expiring" | "stalled" | "reconnect" | "broken" | "stranded";

export interface Health {
  state: HealthState;
  level: "error" | "warn" | "info" | null;   // error = you must act; warn = watch it; info = progress
  message: string | null;                   // one line, naming the bank
  detail: string | null;                    // what the error means, in plain words
  fix: string | null;                       // what to do about it
  action: "reconnect" | "relink" | null;    // the button the dashboard offers
  error_code: string | null;
  plaid_message: string | null;             // Plaid's own text for error_code
  last_success: string | null;              // last successful sync (ISO)
}

export interface BankRow {
  id: number;
  owner: string;
  plaid_account: string;
  institution_name: string | null;
  status: string;
  updated_at: string;
  last_error: string | null;
  last_error_message: string | null;
  downloading: number;
  synced_once: number;
  consent_expires_at: string | null;
  txns: number;
  products?: string;                        // 'investments': an Investments-only login (EGG)
  inv_status?: string | null;               // its investment_sync status
  inv_synced_at?: string | null;
  inv_error?: string | null;
}

/** Every bank with what its verdict needs. Statuses other than good / login_required / error
 * (e.g. 'demo' in the seed data) aren't synced and are always "ok". */
export const BANK_ROWS_SQL = `
  SELECT i.id, i.owner, i.plaid_account, i.institution_name, i.status, i.updated_at,
         i.last_error, i.last_error_message, i.consent_expires_at,
         i.sync_start_cursor IS NOT NULL AS downloading, i.txn_cursor IS NOT NULL AS synced_once,
         -- counted only while a history download runs (the only message that shows it): counting
         -- every bank's transactions on each /health poll read the whole table each time
         CASE WHEN i.sync_start_cursor IS NOT NULL
              THEN (SELECT count(*) FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.item_id = i.id)
              ELSE 0 END AS txns,
         i.products, s.status AS inv_status, s.synced_at AS inv_synced_at, s.last_error AS inv_error
  FROM items i LEFT JOIN investment_sync s ON s.item_id = i.id`;

/** Plaid error codes (and Minty's own) in plain words. Unknown codes fall back to Plaid's text. */
const MEANING: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: "The bank wants you to sign in again, e.g. after a password change or a new security check.",
  ITEM_LOCKED: "The bank locked this login after too many attempts. Unlock it on the bank's own site first.",
  INVALID_CREDENTIALS: "The bank rejected the saved username or password.",
  INVALID_MFA: "The bank's security code check didn't go through.",
  USER_SETUP_REQUIRED: "The bank wants you to finish something on its own site first, e.g. accept new terms.",
  INSUFFICIENT_CREDENTIALS: "Signing in through the bank wasn't completed.",
  INVALID_UPDATED_USERNAME: "The bank didn't accept the new username.",
  PENDING_EXPIRATION: "The bank's consent through Plaid is about to run out.",
  ITEM_NOT_FOUND: "Plaid no longer recognises this connection (it was removed on Plaid's side).",
  INVALID_ACCESS_TOKEN: "Plaid no longer accepts this connection's access token.",
  ACCESS_NOT_GRANTED: "The connection no longer shares the data Minty needs (access was turned off at the bank or in Plaid).",
  NO_ACCOUNTS: "The bank says this login has no accounts any more.",
  INVALID_API_KEYS: "Plaid rejected the API keys of the Plaid account this bank is linked under.",
  INVALID_PRODUCT: "This connection isn't set up for transactions.",
  PRODUCTS_NOT_SUPPORTED: "This bank doesn't offer transactions through Plaid.",
  ITEM_NOT_SUPPORTED: "Plaid doesn't support this kind of login at this bank.",
  INSTITUTION_NO_LONGER_SUPPORTED: "Plaid no longer supports this bank.",
  INSTITUTION_DOWN: "The bank's systems are down. Minty keeps retrying.",
  INSTITUTION_NOT_RESPONDING: "The bank isn't answering Plaid. Minty keeps retrying.",
  INSTITUTION_NOT_AVAILABLE: "The bank isn't available through Plaid right now. Minty keeps retrying.",
  INSTITUTION_REGISTRATION_REQUIRED: "Plaid needs extra approval before it can connect to this bank.",
  INTERNAL_SERVER_ERROR: "Plaid had a temporary problem. Minty keeps retrying.",
  PLANNED_MAINTENANCE: "Plaid is down for maintenance. Minty keeps retrying.",
  RATE_LIMIT_EXCEEDED: "Plaid asked Minty to slow down. Minty keeps retrying.",
  PRODUCT_NOT_READY: "Plaid is still preparing this bank's data (normal just after linking). Minty tries again shortly.",
  NO_INVESTMENT_ACCOUNTS: "Plaid sees no investment accounts on this login.",
  INVESTMENTS_FAILED: "Fetching the investment accounts failed. Minty retries every hour.",
  RESPONSE_TOO_LARGE: "Plaid's reply was larger than Minty accepts. Minty retries every hour.",
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: "Plaid's data changed during the download, so Minty restarts it automatically.",
  TOKEN_DOES_NOT_DECRYPT: "The stored connection can't be decrypted with TOKEN_ENC_KEY (the key was changed). If you changed it on purpose, add the old key as TOKEN_ENC_KEY_PREVIOUS: the next hourly sync picks this bank up again (SETUP.md, Changing the encryption key).",
  REQUEST_FAILED: "Minty couldn't reach Plaid. It keeps retrying.",
  SAVING_A_PAGE_FAILED: "Saving transactions to the database failed. Minty keeps retrying.",
  INVALID_SYNC_PAGE: "Plaid sent a reply Minty couldn't read. Minty keeps retrying.",
};

export function describeError(code: string | null, plaidMessage: string | null): string | null {
  if (!code) return null;
  return MEANING[code] ?? (plaidMessage ? `Plaid says: ${plaidMessage}` : `Plaid error ${code}.`);
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export function ago(hours: number): string {
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}

const OK = (row: BankRow): Health => ({ state: "ok", level: null, message: null, detail: null, fix: null, action: null,
  error_code: row.last_error, plaid_message: row.last_error_message, last_success: row.updated_at });

export const bankName = (row: Pick<BankRow, "id" | "institution_name">) => row.institution_name || `Bank #${row.id}`;

/** Why a bank's credential set can't be used, or null if it can. */
export function strandedWhy(env: Env, config: Config, plaidAccount: string): string | null {
  if (!config.accountOwner.has(plaidAccount)) return "isn't in MINTY_USERS / PLAID_SLOTS any more";
  return keyState(env, config, plaidAccount) === "set" ? null : "has no Plaid keys";
}

export function bankHealth(env: Env, config: Config, row: BankRow, now = Date.now()): Health {
  if (!["good", "login_required", "error"].includes(row.status)) return OK(row);
  const bank = bankName(row);
  const base = { ...OK(row), detail: describeError(row.last_error, row.last_error_message) };

  const why = strandedWhy(env, config, row.plaid_account);
  if (why) {
    return { ...base, state: "stranded", level: "error", message: `${bank} can't sync: its Plaid account (${row.plaid_account}) ${why}.`,
             detail: null, fix: "Restore that person or slot and its Plaid keys. A bank stays with the Plaid account it was linked under." };
  }
  if (row.status === "error") {
    return { ...base, state: "broken", level: "error", message: `${bank} stopped syncing and won't retry.`,
             fix: "Link it again from + Add account.", action: "relink" };
  }
  if (row.status === "login_required") {
    return { ...base, state: "reconnect", level: "error", message: `${bank} needs you to sign in again.`,
             fix: "Use Reconnect. Nothing is lost: it catches up once you're signed in.", action: "reconnect" };
  }
  const consentDays = row.consent_expires_at ? (Date.parse(row.consent_expires_at) - now) / 8.64e7 : Infinity;
  if (consentDays <= 0) {
    return { ...base, state: "reconnect", level: "error", message: `${bank}'s access through Plaid ended on ${day(row.consent_expires_at!)}.`,
             detail: "The consent you gave the bank for Plaid has run out, so new transactions stop.",
             fix: "Use Reconnect to renew it.", action: "reconnect" };
  }
  if (row.products === "investments") return investmentsHealth(row, bank, base, consentDays);
  const hours = (now - Date.parse(row.updated_at)) / 3.6e6;
  if (hours > STALE_SYNC_HOURS) {
    return { ...base, state: "stalled", level: "warn",
             message: `${bank} hasn't synced for ${ago(hours)} (last successful sync ${day(row.updated_at)}).`,
             detail: base.detail ?? "No sync attempt has failed, so sync may not be running at all.",
             fix: row.last_error
               ? "Minty keeps retrying. If this lasts more than a day, check the Worker's logs (Workers & Pages → minty → Logs)."
               : "Check the cron triggers (Workers & Pages → minty → Settings → Trigger events) and the logs." };
  }
  if (consentDays <= CONSENT_WARN_DAYS) {
    return { ...base, state: "expiring", level: "warn", message: `${bank}'s access through Plaid ends on ${day(row.consent_expires_at!)}.`,
             detail: `The consent you gave the bank for Plaid runs out on ${day(row.consent_expires_at!)}, and new transactions would stop then.`,
             fix: "Use Reconnect before then to renew it.", action: "reconnect" };
  }
  if (row.downloading) {
    return { ...base, state: "downloading", level: "info",
             message: `${bank}: downloading its history (${row.txns} transaction${row.txns === 1 ? "" : "s"} so far).`,
             detail: "Newer transactions appear once it's done.", fix: null };
  }
  return OK(row);
}

/** An Investments-only login (EGG): there's no transaction sync to judge, so its verdict comes
 * from the investments fetch (src/investments.ts), refreshed about once a day. */
export const STALE_INVESTMENTS_HOURS = 48;
function investmentsHealth(row: BankRow, bank: string, base: Health, consentDays: number, now = Date.now()): Health {
  const detail = describeError(row.inv_error ?? null, null);
  if (row.inv_status === "consent_required") {
    return { ...base, state: "reconnect", level: "error", message: `${bank} needs you to sign in again for its investment accounts.`,
             detail, fix: "Use Reconnect. The accounts already saved stay.", action: "reconnect" };
  }
  if (row.inv_status === "unsupported") {
    return { ...base, state: "broken", level: "warn", message: `${bank} doesn't share its investment accounts through Plaid.`, detail, fix: null };
  }
  if (consentDays <= CONSENT_WARN_DAYS) {
    return { ...base, state: "expiring", level: "warn", message: `${bank}'s access through Plaid ends on ${day(row.consent_expires_at!)}.`,
             detail: "The consent you gave for Plaid runs out then, and its balances would stop updating.", fix: "Use Reconnect before then to renew it.", action: "reconnect" };
  }
  if (!row.inv_synced_at) {
    return { ...base, state: "downloading", level: "info", message: `${bank}: fetching its investment accounts (within about 10 minutes, or longer if Plaid is still preparing them).`,
             detail, fix: null };
  }
  const hours = (now - Date.parse(row.inv_synced_at)) / 3.6e6;
  if (hours > STALE_INVESTMENTS_HOURS || row.inv_status === "error") {
    return { ...base, state: "stalled", level: "warn", message: `${bank}'s investment accounts haven't updated for ${ago(hours)}.`,
             detail: detail ?? "No fetch has failed, so the catch-up cron may not be running.", fix: "Minty keeps retrying. If this lasts, check the Worker's logs." };
  }
  return { ...OK(row), last_success: row.inv_synced_at };
}

/** Whether sync runs at all: the most recent successful sync of any bank that can sync. */
export function syncHealth(env: Env, config: Config, rows: BankRow[], now = Date.now()): { ok: boolean; message: string; fix?: string } | null {
  const live = rows.filter((r) => ["good", "login_required"].includes(r.status) && r.products !== "investments" && r.synced_once && !strandedWhy(env, config, r.plaid_account));
  if (!live.length) return null;
  const last = Math.max(...live.map((r) => Date.parse(r.updated_at)));
  const hours = (now - last) / 3.6e6;
  return hours > STALE_SYNC_HOURS
    ? { ok: false, message: `No bank has synced for ${ago(hours)}.`,
        fix: "Check the Worker's cron triggers (Workers & Pages → minty → Settings → Trigger events) and its logs." }
    : { ok: true, message: `Last sync ${hours < 1 ? "within the hour" : `${Math.round(hours)} h ago`}.` };
}

export async function bankRows(env: Env): Promise<BankRow[]> {
  return (await env.DB.prepare(`${BANK_ROWS_SQL} ORDER BY i.owner, i.id`).all<BankRow>()).results;
}
