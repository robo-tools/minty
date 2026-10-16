/** Worker bindings and settings. Plain settings come from wrangler.jsonc "vars"; secrets from
 * `wrangler secret put` (deployed) or .dev.vars (local). Per-person Plaid keys are dynamic:
 * PLAID_CLIENT_ID_<KEY>_<SLOT> / PLAID_SECRET_<KEY>_<SLOT>, hence the index signature. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Rate limits per login (wrangler.jsonc "ratelimits"). Missing = not limited (src/limits.ts). */
  RL_GENERAL?: RateLimit;
  RL_SEARCH?: RateLimit;
  RL_LINK?: RateLimit;

  MINTY_USERS?: string;
  /** Plaid credential slots per person, in overflow order. Default "primary,backup". */
  PLAID_SLOTS?: string;
  PLAID_ENV?: string;
  PLAID_REDIRECT_URI?: string;
  TRIAL_ITEM_CAP?: string;
  /** Plaid pages synced per cron run (each = 1 Plaid call + 1 D1 batch). Default 10. */
  SYNC_MAX_PAGES_PER_RUN?: string;
  /** Page text synced per cron run, in bytes. Default 150,000 (median ~8 ms CPU measured; free plan allows 10). */
  SYNC_MAX_BYTES_PER_RUN?: string;
  /** D1 rows the pages may read per UTC day before heavy routes pause. Default 3,000,000; "0" = off. */
  READ_BUDGET_PER_DAY?: string;

  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_LOGINS?: string;
  /** Local development only (.dev.vars). Skips Access, and only for localhost requests. */
  MINTY_DEV_NO_AUTH?: string;

  TOKEN_ENC_KEY?: string;
  /** Only while changing the key (src/token-key.ts): the old TOKEN_ENC_KEY, which still opens the
   * tokens saved under it until each is saved again under the new one. */
  TOKEN_ENC_KEY_PREVIOUS?: string;
  /** "off": never ask irs.gov for the contribution limits (src/retirement/irs.ts). Default on. */
  IRS_LIMITS?: string;

  [key: string]: unknown;
}
