# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Minty — Project Context

Self-hosted personal finance aggregator that consolidates bank and credit card
transactions for a household (one person by default; any number via `MINTY_USERS`) into one
private dashboard.
Anyone can fork it and run their own copy on Cloudflare's free plans. It's source-available under
PolyForm Strict 1.0.0 (`LICENSE`): use unmodified, noncommercial only; no changes or redistribution.
Goals: full data ownership, no subscription fees, no public endpoints.

**Current status and to-do: `docs/STATUS.md`. Read it first when resuming work.** If
`docs/private/STATUS.md` exists (the owner's private notes, gitignored), read it too.
Security work: `docs/security-plan.md` (decisions and to-do).
Design history and decisions: `docs/serverless-plan.md`.

## Stack
- Cloudflare Worker (TypeScript, `src/`) + D1 (SQLite, `d1/migrations/`), one deployment
  per household. Pages are static files in `public/` (Workers assets); API paths are listed in
  `wrangler.jsonc` `assets.run_worker_first` and run through the Worker.
- Financial data: Plaid (Trial plan). Sync runs from an hourly cron trigger,
  plus a 10-minute catch-up trigger for banks partway through a history download.
- Access: Cloudflare Access at the edge, plus a login-token check in the Worker.
- Each household deploys its own fork with Cloudflare Workers Builds (`npm run deploy`);
  onboarding is `SETUP.md`. Development with `wrangler dev` on any machine (Node 22+).

## Architecture invariants (do not change without asking)
- `owner` (a `MINTY_USERS` key; default just `me`) and `plaid_account` (which
  Plaid credential set) are DISTINCT concepts. Never collapse or infer one from
  the other.
- People come from the `MINTY_USERS` Worker variable. Each person has one credential set per
  slot in `PLAID_SLOTS`, in overflow order (default `primary,backup`; up to 10). The sets are
  `<key>_<slot>`, with `PLAID_CLIENT_ID_<KEY>_<SLOT>` / `PLAID_SECRET_<KEY>_<SLOT>` secrets. The
  `/add-user` page generates the values; Plaid secrets never go through the browser or the
  database.
- Routing of new institutions goes through `chooseAccountFor()` (`src/routes/link.ts`): the
  first slot that has keys and is under the cap. Slots without keys are skipped, so people can
  have different numbers of Plaid accounts. An Item keeps its `plaid_account` for good, so
  removing a slot or person that still has Items strands them (they're skipped, and `/status`
  flags them).
- Linking goes through Link sessions (`link_sessions`, `src/routes/link.ts`): `/link/token`
  reserves a slot (banks + open reservations under the cap, one statement per slot), and
  `/link/exchange` claims the session once, before Plaid's exchange, taking owner and
  plaid_account from it. Never trust either from the browser.
- A Plaid Item = one institution login (not one account). The Trial cap is
  10 Items per credential set (`TRIAL_ITEM_CAP`); routing logic depends on this.
- Plaid access tokens are stored Fernet-encrypted (`src/fernet.ts`, `TOKEN_ENC_KEY`).
  Never log, print, or return decrypted tokens. Open them with `openAccessToken()`
  (`src/token-key.ts`), never `fernetDecrypt` directly: it also takes `TOKEN_ENC_KEY_PREVIOUS`
  while the key is being changed, and moves each token to the new key.
- Transaction sync is cursor-based and incremental.
- There is NO HTTP sync endpoint, by design. Sync runs only from the cron triggers
  (`/link/exchange` starts the first sync of a new Item internally). Do not add one.
  `/link/reconnected` only re-checks a connection with Plaid's `/item/get`; it never syncs.
  Clicking the logo on the dashboard only *records* a sync request (`POST /sync-request`, in
  `app_state`); the next cron run (the 10-minute catch-up at the latest) then sweeps every bank.
  No request path ever calls Plaid's `/transactions/sync`.
- Sync problems are never silent: every failure is recorded on the item (`last_error`,
  `last_error_message`), and `src/health.ts` turns it into the one verdict the dashboard's
  status strip (`/health`) and Setup checks (`/status`) both show. New failure modes get a
  plain-words entry in its `MEANING` table.
- Trust model: every login that passes Access and `ALLOWED_LOGINS` is fully trusted with the
  whole household (all people's data, linking and reconnecting banks). `owner` is a view filter,
  not an access boundary. Decided 2026-10-14 (`docs/security-plan.md` §2); don't add roles
  without asking.
- Auth: Cloudflare Access guards the hostname; every API route also re-validates the
  Access JWT (`src/access.ts`) and applies the optional `ALLOWED_LOGINS` allow-list.
  **Missing `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` means everything is refused.** `/healthz`
  is the only ungated path. State-changing requests from another origin are refused.
- D1 migrations live in `d1/migrations/NNNN_*.sql`, are tracked in `d1_migrations`, and are
  applied automatically on deploy. New schema changes go in a new file, never an edited one;
  `src/routes/status.ts` lists every migration (a test checks this).

## Data conventions
- Plaid amount sign: POSITIVE = money out. Stored as integer cents (`amount_cents`); the
  dashboard flips the sign for display.
- Tags live in `transaction_tags` rows. Sync never writes them, so user labels survive
  re-syncs. Keep it that way.

## Commands
- Install: `npm ci` (Node 22+)
- Tests: `npm test` (vitest inside workerd, real local D1; Plaid never called)
- Single test file / name: `npx vitest run test/link.test.ts -t overflow`
- Types: `npm run typecheck`
- Local DB: `npm run db:migrate:local && npm run db:seed:local`
- Run locally: `npm run dev` then http://localhost:8787 (passes `--var MINTY_DEV_NO_AUTH:1`,
  which skips Cloudflare Access and is only honoured for localhost requests)
- Local cron sync (`npm run dev` enables the trigger):
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"` (catch-up only:
  `cron=*/10+*+*+*+*`)
- Deploy: `npm run deploy` (`scripts/deploy.mjs`, run by Workers Builds on push to `main`):
  migrate then deploy, or deploy first on the very first run (it creates D1).
- Plaid Sandbox end-to-end: `node scripts/sandbox-e2e.ts` against `npm run dev`. It reads
  `.dev.vars`, so the user runs it, not Claude.

## Rules for changes
- `wrangler.jsonc` is shared by every household's fork: never add per-household values to it
  (no `database_id`, no `vars`). Household settings are dashboard variables (kept by
  `keep_vars`) or secrets. That's what keeps "Sync fork" conflict-free. New settings need a
  code default, a line in the `wrangler.jsonc` header comment, and a `/status` check if required.
  Ignore Cloudflare's "Update your Wrangler configuration" prompt for the same reason.
- Never put `MINTY_DEV_NO_AUTH` in `.dev.vars.example`: the Deploy button turns that file into
  secret prompts. CI checks this.
- Worker sync (`src/sync.ts`): one D1 batch per Plaid page (the cursor advances with its page).
  The Worker never parses a page: the text is bound once into `sync_pages` and SQLite unpacks
  it. Each run has a byte and a page budget (`SYNC_MAX_BYTES_PER_RUN` / `SYNC_MAX_PAGES_PER_RUN`),
  sized from measurements against the free plan's 10 ms CPU limit (docs/serverless-plan.md §8).
  Don't add per-row work or JSON.parse on the page path, and never bind pages as bytes
  (18 ms per page). Transient Plaid errors retry next run; only item-level errors change
  `items.status`. An update spanning runs keeps the cursor it began from
  (`items.sync_start_cursor`); `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts from there,
  never from the run's own cursor (that fails forever).
- Bills (`docs/bills.md`): preserve the fork's standalone page at `/bills`, APIs under
  `/liabilities` and `/manual-bills`, and statement consent purpose `liabilities`.
  The dedicated `LIABILITIES_CRON` fetches one bank per tick; no second statement fetcher.
  Payments are estimates from verified card history; no last-payment double counting,
  unqualified Paid status, or overdue inference from a past date. Applied migrations
  0001–0013 stay unchanged. See `docs/upstream-integration.md` for the additive bridge.
- CFA, the audit (`docs/cfa.md`): `src/audit/totals.ts` puts each posted transaction in one bucket
  (income, spend, saving, transfer, debt) in SQL, and keeps `monthly_totals` and `balance_snapshots`
  from the hourly cron, never on a request. A full rebuild runs weekly or after a correction; other
  runs refresh only from the earliest new transaction's month (quiet 10-minute runs too, so a
  correction shows within minutes). `/audit` reads `monthly_totals`, `net_worth` and
  `recurring_charges`, never the transactions. Corrections live in `bucket_overrides`, which sync
  never writes. Changing the bucket rules means bumping `RULES_VERSION`. The popup is
  `public/cfa.js`, with `public/charts.js` (our own SVG charts, no library). Recommendations are
  rules in `src/audit/rules.ts` (pure, tested, each with its basis and `CHECKED`), run by
  `GET /audit/advice` on prepared data. Every finding shows its numbers, and the pages say
  "educational, not financial advice".
- BAM, miles and points (`docs/bam.md`): balances typed in or read from statement PDFs in the
  browser, never from a loyalty login, scraping or Plaid. Each update is a new reading in
  `point_balances`. The program list, expiry rules and "earned by" rules are code
  (`src/points/programs.ts`, `CHECKED`); an expiry rule only where the program's terms are simple.
  `public/pdf-read.js` reads PDFs on the device and remembers a folder for BAM. The reusable
  helper keeps separate "already added" and skipped lists for each consuming view; this fork's
  Bills page does not import PDFs. `GET /points` reads each reading once, with no `ORDER BY`
  (D1 counts a sort as a second read).
- EGG, retirement accounts (`docs/cfa.md` §3, §5.4): Plaid Investments, through a new
  Investments-only login (`items.products = 'investments'`, which the transaction sync skips) or
  update-mode consent on a bank already linked (like statement details). It's fetched only by a
  quiet catch-up cron run (`src/investments.ts`, one bank per run), never on a request, and a
  failure there never touches `items.status`. Retirement accounts (HSAs included) are islanded:
  `/accounts` and `/transactions` leave them out unless `accounts.view` says 'dashboard' (use
  `IN_RETIREMENT()`). The view is `public/egg.js` with `GET /retirement`, whose queries start from the
  accounts (`CROSS JOIN`) so they never walk every transaction. IRS limits are fetched from irs.gov
  once a year (`src/retirement/irs.ts`): the COLA table and Publication 969, asked from a quiet
  catch-up run only while a year isn't settled, at most weekly, never on a request. Every figure
  is sanity-checked against `src/retirement/limits.ts`, which stays the fallback. `IRS_LIMITS=off`
  never asks; tests run with it off.
- ABC card credits (`docs/abc.md`): the benefit list is code (`src/benefits/catalog.ts`, with
  sources and a `CHECKED` date), never fetched at runtime. Credit patterns always name the
  credit. Never match a bare merchant word (a resort in Wisconsin Dells isn't Dell).
  `/benefits` keeps string matching in SQL (rows come back tagged), because a cold isolate has
  10 ms of CPU.
- Device lock (`public/lock.js`, `lock.css`, loaded at the end of `<head>` on every page with
  data): WebAuthn with a passkey on the device, on by default where the device has a built-in
  authenticator, and never locking anyone out where it hasn't. A visibility gate only: it never
  calls the Worker or stores anything in D1. The live demo strips it (`scripts/build-demo.mjs`).
- Installable app (`public/manifest.webmanifest`, `public/sw.js`): the manifest link needs
  `crossorigin="use-credentials"` or Access answers it with the sign-in page. The service worker
  caches only the listed static shell files, never an API response (no financial data on the
  device), and never caches a redirect (the Access sign-in).
- This customized fork updates weekly through `.github/workflows/stay-up-to-date.yml` and
  `scripts/upstream-sync.mjs`, scoped to `robo-tools/minty`. It tests a normal merge in a
  read-only job, then publishes the immutable candidate only if main still matches its base.
  Conflicts, workflow/updater changes, and migration collisions/order changes stop for review.
  Never force-sync away the fork's features. No workflow directly deploys (Cloudflare does
  after a main push). The updater is active on `main`; see `docs/fork-updates.md`.
- **D1 rows read are a daily budget** (free plan: 5,000,000 a day, then every read fails until
  00:00 UTC). A full scan of `transactions` reads every row (thousands on a real household).
  Joining a `json_each` list against transactions reads them once per list entry, which is what
  blew the budget on 2026-10-12.
  Every page-facing route has a budget in `test/reads.test.ts`: keep new queries index-driven and
  add a line there. Check `rows_read` before running ad-hoc remote queries over transactions.
- Limits (`src/limits.ts`): every API request passes the per-login rate limits (wrangler.jsonc
  `ratelimits`) right after the Access check, before any D1 or Plaid work. A missing binding
  means no limit, never a lockout. Requests that read more than 1,000 rows add to a per-day
  counter in `app_state`; past `READ_BUDGET_PER_DAY`, `GET /transactions`, `/accounts` and
  `/benefits` are refused until 00:00 UTC. The cron never checks it. A new route whose reads grow
  with the transactions goes in `isHeavyRead`. Bodies are read with `jsonBody` (16 KiB cap), never
  `request.json()`. D1 allows 50 bytes in a LIKE pattern, so user text in a LIKE needs a byte cap.
- Browser headers (security plan step 4): `public/_headers` sets the pages' Content-Security-Policy
  (`script-src 'self'`; `/connect` has its own, with Plaid Link's hosts), `nosniff`, a same-origin
  referrer policy and a Permissions-Policy; `json()` in `src/http.ts` sets the API's. So pages have
  **no inline scripts or `on…=` handlers** (each page's script is a file: `theme.js`, `app.js`,
  `connect.js`, `add-user.js`; a test checks). Anything new loaded from another origin needs its
  host in the policy. The CSP is enforced (since 2026-10-16), so a missing host breaks it. A new page script goes
  in `sw.js`'s shell too.
- Live demo (`demo/`, `npm run build:demo`, `docs/demo.md`): the real dashboard and Worker in the
  browser over sql.js, with a made-up household. It's built from `public/` and `src/`, so it follows
  their changes; the build checks every edit it makes to `public/index.html`, `app.js` and `theme.js` and stops when one no
  longer applies (fix the edit, never the check). Its data stays made up (`test/demo.test.ts`), and
  it never talks to a real Minty or to Plaid.
- Fernet reference vectors (`test/fixtures/fernet-vectors.json`, test key only) pin the
  encryption to the reference implementation. Don't regenerate them casually.

## Safety
- The live household deployment is the Cloudflare Worker. Ask before running remote D1
  migrations or commands (`wrangler … --remote`) against it, or before switching it from
  Plaid Sandbox to production.
- Never read or modify `.dev.vars` or any secrets file. Never commit secrets or
  household-specific values (emails, Access team/AUD, workers.dev address) to this public repo.
  That includes notes about the household's data: bank or card names, counts of banks,
  accounts or transactions, consent dates, Access policy details. Those go in
  `docs/private/STATUS.md`; public docs say "a bank", "several accounts".
  If a new setting is needed, add a placeholder to `.dev.vars.example` (secrets) or the
  `wrangler.jsonc` header comment (variables) and tell me.
- Develop and test against Plaid Sandbox credentials, not live Items.

## Working style
- Architecture first: discuss design and trade-offs before writing code.
  For anything non-trivial, propose a plan and wait for my go-ahead.
- When implementing, deliver complete working code, not stubs or pseudocode.
- Validate before declaring done: `npm test` and `npm run typecheck`, and exercise
  config/routing logic against dummy credentials.

## Known open items
- Using multiple Plaid Trial accounts per person to exceed the 10-Item cap is a
  Plaid ToS gray area. Long-term cleaner option: one paid Plaid account per
  person. Deferred, not forgotten.
