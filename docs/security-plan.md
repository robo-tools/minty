# Plan: security hardening after the 2026-10-14 review

**Status: decisions made (2026-10-14, §2); steps 1–4 done (step 4 enforced 2026-10-16); step 5 in progress (5a done). To-do list: §4.** Written 2026-10-14.

An external review of `main` at 183d15b (API, pages, encryption, migrations, workflows, tests)
found no unauthenticated path to financial data. Its main risks were how updates reach a
deployment, what any signed-in login can do, and running out of D1 or Plaid capacity. This
plan covers its seven findings. Baseline at 183d15b: 275 tests pass, typecheck is clean, and
the production dependency (`jose`) has no advisories. The dev toolchain (wrangler/miniflare)
has advisories; those run at build time only and are handled by normal wrangler updates.

## 1. Findings, and what the code adds to them

1. **Updates (high).** A fork's weekly `gh repo sync` puts upstream `main` on the fork's `main`,
   and Workers Builds then migrates and deploys it with the household's database and secrets.
   Fernet doesn't help here: code running in the Worker has `TOKEN_ENC_KEY`. Two more paths:
   Workers Builds builds *other branches* too, running that branch's code with the account's
   build token (and a version upload binds the same D1), and `npm ci` runs dependency install
   scripts in the same build.
2. **Capacity (medium).** No rate limits. A search that matches nothing reads every
   transaction (thousands of rows on a real household) even with `limit=1`. Rate limits alone
   don't protect the daily D1 budget (5,000,000 rows): 20 such searches a minute is tens of
   millions of rows a day. The budget needs its own guard.
3. **Privileges (high if member privacy is expected).** Every admitted login can read every
   person's data, retag it, and reconnect any bank; `owner` is a filter, not a boundary. This
   is the shared-household model, now made explicit (decision 2).
4. **Browser headers (medium).** No CSP, framing or referrer policy in the repo. `_headers`
   covers static files only; Worker responses must set their own. CSP violation reports can't
   reach an Access-protected endpoint, so the report-only phase is checked in the browser.
5. **Rotation and disconnect (medium).** One key, documented as "never change"; no Plaid token
   rotation; no way to disconnect a bank. On Plaid's Trial plan `/item/remove` does not return
   a slot, so a disconnected bank still counts toward `TRIAL_ITEM_CAP`.
6. **Link sessions (medium/low).** The cap is checked at `/link/token` but not at exchange, and
   `/link/exchange` trusts the owner/slot the browser sends. On Trial this matters more than it
   looks: an access token created past the cap spends a real Plaid slot for good. One shared
   set of localStorage keys serves every Link flow and survives a cancel.
7. **Public docs (low).** `docs/STATUS.md` and `docs/serverless-plan.md` named the household's
   banks, counts, consent dates and Access policy shape. Moved out in step 1; Git history and
   forks keep the old text, which held no secrets, so history is not rewritten.

## 2. Decisions (2026-10-14, owner)

- **Forks update from signed release tags, after 7 days.** Not the tip of `main`. The workflow
  checks the tag's signature against the owner's SSH signing key, pinned in a file under
  `.github/workflows/`. The Actions token can't change that directory, so replacing the key
  needs a visible manual Sync fork, even after a GitHub account takeover. The 7 days give time
  to pull a bad release. The owner signs release tags from now on.
- **Every admitted login is fully trusted.** No roles. Documented in README and SETUP, with
  `/status` warnings when `ALLOWED_LOGINS` is empty, and a tighter Access policy (specific
  emails). Rate limits, same-origin checks and confirmations guard the destructive actions.
- **A disconnected bank keeps its history.** Disconnect calls Plaid `/item/remove`, wipes the
  stored token, and marks the item `removed`. Its accounts, transactions and tags stay. Sync,
  the daily connection check and reconnect skip it; the dashboard labels it disconnected. The
  item row stays, so the Trial count stays right.

## 3. Design per step

**Step 2: limits and the D1 budget.** Workers Rate Limiting bindings (two fixed namespace ids
in `wrangler.jsonc`, no per-household values), keyed by the Access email and checked before any
D1 or Plaid work: a general limit, a tight one on `/link/*`, and one on searches and `/benefits`.
Request bodies are capped before parsing; search text has a maximum length. D1 reports
`rows_read` per query: any request that reads more than ~1,000 rows adds it to a per-day counter
in `app_state`, and expensive reads are refused past a threshold that leaves room for sync and
normal page loads. Cheap requests never write. Full-text search only if the numbers call for it.
Check once deployed that the binding actually refuses.

**Step 3: Link sessions (migration 0009).** `link_sessions (id, email, operation, owner,
plaid_account, item_id, created_at, expires_at, used_at)`. `/link/token` reserves a slot in one
statement: Items plus open reservations must be under the cap, slot by slot in `PLAID_SLOTS`
order. `/link/exchange` takes `session_id` and `public_token` only, claims the session once
(same email, unused, unexpired) and takes owner and slot from it, before Plaid's exchange, so a
refused exchange spends nothing. Cancel releases the reservation; expired ones stop counting and
are cleared by cron. Update mode gets a session and a per-bank cooldown. The connect page keeps
one storage entry per session with an expiry, with the tab remembering its own; it's cleared on
success, cancel and expiry.

**Step 4: headers.** `public/_headers` with a strict policy for every page (`script-src 'self'`,
`frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `nosniff`, a same-origin
referrer policy). The pages' inline scripts move to `.js` files (hashes would break on every
edit). `connect.html` drops the inherited CSP (`! Content-Security-Policy`) for its own policy
with Plaid's documented Link directives: nonce mode if Plaid's web SDK supports it on a
Worker-served page (tried on Sandbox), otherwise Plaid's `'unsafe-inline'` variant for that page
only. `json()` and the asset fallthrough in `src/index.ts` set their own headers. Checked in
devtools and a headless browser locally before enforcing.

**Step 5: rotation and disconnect.**
- `TOKEN_ENC_KEY_PREVIOUS`: decrypt tries the current key, then the previous one; encrypt always
  uses the current one. The hourly cron re-encrypts what's left on the old key, and `/status`
  says when it's safe to delete. No schema change. SETUP's "never change" becomes a procedure.
- Plaid token rotation (`/item/access_token/invalidate`) per bank and "rotate all", one bank at
  a time, saving the new token with retries: if the save fails after Plaid rotated, that bank
  must be linked again, so the page says so before you start.
- Disconnect as in decision 3. Some OAuth banks still list the connection in their own settings
  afterwards; the page says that too.
- An incident runbook in SETUP: what to rotate for a leaked database, a leaked key, or both.

**Step 6: fork updates** (decision 1). Changes a workflow file, so every fork's next sync fails
once (CLAUDE.md); its own PR, said so in the PR. The one manual Sync fork is also what installs
the pinned key.

## 4. To-do, in order

1. **Settings and docs (no deploy risk).** Done 2026-10-14.
   - [x] Move household-specific notes to `docs/private/` (gitignored, kept in a private repo).
   - [x] Document the trust model (README, SETUP, CLAUDE.md) and prefer an Emails policy in SETUP.
   - [x] GitHub, `rg-code/minty`: a ruleset on `main` that requires a pull request and the
         status check **Worker (vitest in workerd + typecheck)** (pinned to GitHub Actions), blocks
         force pushes and deletion, with an empty bypass list. 2FA on the account.
         GitHub adds `require_extra_approval_for_unattributed_changes` to the ruleset; if a PR
         ever waits for an approval nobody can give, check that setting first.
   - [ ] Claude Code's Git credential: a fine-grained token for this repo only, Contents read
         and write, no Workflows permission. Skipped for now (optional): the ruleset protects
         `main` whatever credential is used.
   - [x] Workers Builds: builds for preview branches turned off (**Settings → Builds → Previews
         Base**). Production stays on `main` with `npm run deploy`. PRs are still checked by
         `test.yml`, which holds no Cloudflare credentials. Never set the preview command to
         `npm run deploy`: `scripts/deploy.mjs` doesn't check the branch, so it would migrate and
         deploy production.
   - [x] Workers Builds: the build token was the broad one created at import (Email Routing,
         SSL, Workers Routes on every zone, and more). Narrowed in place to Workers Scripts Edit
         and D1 Edit, this account only; the next production build migrated and deployed.
   - [x] Access: an Emails policy listing each address replaces the email-domain policy, and
         the application's session is shorter (SETUP suggests 24 hours).
   - [x] Access: MFA on the owner's deployment. There's no simple version for forks: it's
         several Zero Trust settings and a per-person enrollment that Minty can't automate
         without a token that edits Access. SETUP keeps it optional.
   - [x] 2FA on Cloudflare, Plaid, and the inbox that receives the sign-in codes.
2. **Rate limits and the D1 budget** (§3), with `test/reads.test.ts` lines for anything new,
   plus a `/status` warning when `ALLOWED_LOGINS` is empty. **Done 2026-10-14 (#54).**
   - [x] Three rate limiting bindings per login (`src/limits.ts`): 120 requests a minute for
         everything, 30 for searches and ABC loads, 10 for `/link/*`. A missing binding means no
         limit, never a lockout. Checked in production after the deploy: 130 quick requests gave
         121 × 200 and 9 × 429, so the limiter does refuse (approximately, as documented).
   - [x] Bodies capped at 16 KiB before they're read. Search text capped at 48 bytes, because D1
         allows 50 in a LIKE pattern: longer searches had failed with a 500.
   - [x] Daily read budget: requests reading more than 1,000 rows add to `rows_read:<date>` in
         `app_state`. Past `READ_BUDGET_PER_DAY` (default 3,000,000), `/transactions`, `/accounts`
         and `/benefits` pause until 00:00 UTC. `/accounts` and filtered `/transactions` were
         added to the plan's guard because they also read every transaction they look at. The
         cron never checks it and prunes counters after 7 days.
   - [x] Setup checks: `ALLOWED_LOGINS` empty, rate limits off, today's counted reads. A
         household that followed GET-STARTED sees only ✓ (a test pins it).
3. **Link sessions** (§3, migration 0009). **Done (#57).**
   - [x] `/link/token` reserves a slot in `link_sessions`, one `INSERT … SELECT` per slot in
         `PLAID_SLOTS` order, only while banks plus open reservations are under the cap.
   - [x] `/link/exchange` takes `{session_id, public_token}` and claims the session (once, same
         email, unexpired) before Plaid's exchange, taking owner and slot from it. A Plaid error
         releases it; a claimed session that never finishes keeps counting, and Setup checks flag it.
   - [x] `POST /link/cancel` releases an unused session. Update mode gets a session too, at most
         one per bank a minute. `/capacity` reports `reserved`; the hourly cron prunes old sessions.
   - [x] `connect.html` keeps one `localStorage` entry per session with its expiry (plus the
         tab's own in `sessionStorage`), cleared on success, exit and expiry; the old shared keys
         are gone. `scripts/sandbox-e2e.ts` opens a session first.
   - Tests 310 → 331. Changed assertions (owner and slot now come from the session): six exchange
     tests send a `session_id`, three `toEqual`s gain `session_id` and `expires_at`, `/capacity`
     gains `reserved: 0`. None removed.
   - Not in the review, done alongside: the **device lock** (#58), a WebAuthn gate on each device
     before a page shows anything; it never calls the Worker and stores nothing in D1.
4. **Headers** (§3). **Done: report-only (PR 1, #61), then enforced (PR 2, 2026-10-16).**
   - [x] The inline scripts moved to files: one shared `theme.js` (render-blocking in the head, as
         before) and `app.js`, `connect.js`, `add-user.js` at the same spot in their pages. No page
         has an inline `<script>` or `on…=` handler (a test checks). `sw.js` shell lists the new
         files; its cache is `minty-v2`, so installed apps refresh once.
   - [x] `public/_headers`: `Content-Security-Policy-Report-Only` for every page and file
         (`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'
         data:`, no framing, no objects, `base-uri 'none'`, `form-action 'self'`), plus `nosniff`,
         `Referrer-Policy: same-origin` and a Permissions-Policy. `style-src 'unsafe-inline'` is
         kept on purpose (owner, 2026-10-15): inline styles can't run code, and removing them means
         rewriting the style attributes the scripts build. `_headers` applies to files the Worker
         hands back too (`env.ASSETS.fetch`), checked in tests.
   - [x] `/connect` replaces it with its own: Plaid Link's script, `frame-src https://cdn.plaid.com/`
         and `connect-src` for Plaid's production and Sandbox hosts, **without** `'unsafe-inline'`,
         so the report-only phase shows whether Link needs it.
   - [x] Worker responses (`json()`): report-only `default-src 'none'; frame-ancestors 'none'`,
         `nosniff`, the same referrer policy.
   - [x] Owner (2026-10-16, Firefox): a Link update-mode run on `/connect` with devtools open showed
         no report from Minty's policy. The one console line was Plaid's own policy inside Link's
         frame (`'unsafe-eval'`, `*.plaid.com`, reCAPTCHA) blocking one of Plaid's inline scripts:
         Plaid's, outside Minty, and Link worked. So `/connect` stays without `'unsafe-inline'`.
   - [x] PR 2: every `-Report-Only` header became `Content-Security-Policy` (pages, `/connect`, the
         API). Checked in headless Chromium under the enforced policy: dashboard (person switch,
         search, filters, dates, a row, ABC, Bills reading a PDF, sync request, theme, service
         worker), the phone strip, `/connect` (Link's script loads), `/add-user`: no violations.
         Changed assertions: the tests read `content-security-policy` instead of the report-only
         header, and "nothing enforced yet" became "no report-only copy left". None removed.
5. **Rotation and disconnect** (§3), in three PRs (owner, 2026-10-16), each revertable alone.
   - [x] **5a, changing the encryption key.** `TOKEN_ENC_KEY_PREVIOUS` (optional secret, unset by
         default: today's behaviour). Every caller opens tokens through `openAccessToken()`
         (`src/token-key.ts`): the current key, then the previous one; a token opened with the
         previous key is saved again under the current one (only if the row still holds that
         ciphertext, and without touching `updated_at`). The hourly cron (`rekeyTokens`, after
         sync) moves the rest, including banks sync skips, and clears `TOKEN_DOES_NOT_DECRYPT`, so
         a key changed without the previous one set recovers once it's added. Setup checks, only
         while it's set: an invalid previous key, one equal to the current key, "N banks still on
         the old key", then "isn't needed any more" with how to delete it. SETUP: "Changing the
         encryption key" (replacing "never change") and "If something leaks". No schema change; a
         revert leaves every token readable with `TOKEN_ENC_KEY` alone once Setup checks said none
         were left. Changed assertions: none (12 new tests).
   - [ ] **5b, disconnect a bank** (decision 3).
   - [ ] **5c, Plaid token rotation**, and its part of "If something leaks".
6. **Fork updates from signed tags** (§3), its own PR, last.

Each step: complete files, `npm test` and `npm run typecheck`, and a Sandbox check by the owner
where Plaid is involved.

### Rules for every step (2026-10-14, owner)

**No regressions.** Every change strengthens what's built and never breaks it.
- **One branch and one PR per step** (`security/step-N-<name>`), each revertable on its own. The
  PR says what a revert leaves in D1.
- **The design comes first,** with the owner's go before any code. It lists every behaviour
  change a page, an API caller or a fork would notice, and why normal use isn't affected.
- **Existing tests are the contract.** Before pushing, every existing assertion that was changed
  or removed is listed with its reason. New behaviour gets new tests, and any new page-facing
  query gets a budget in `test/reads.test.ts`.
- **Migrations only add** tables or columns. **New settings default to today's behaviour.**
- **A manual checklist covers what the step touched:**
  - the dashboard: load, person switch, search, filters, tags, pagination, status strip and
    sync request;
  - the ABC popup;
  - connect: a new link, OAuth resume and reconnect;
  - Setup checks;
  - the installed app;
  - light and dark themes, and phone.
- **Step 4** ships CSP as report-only first. A follow-up PR enforces it once the owner sees no
  violations. New `.js` files go into `public/sw.js`'s cached list.
- **Step 6** merges only after the owner has cut the first signed release tag.
