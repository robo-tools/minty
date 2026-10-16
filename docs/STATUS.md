# Minty status and to-do

Handoff notes for continuing on another machine. Last updated 2026-10-14.
This file is public, so it holds no household specifics: no addresses, Access team or AUD,
emails, bank or card names, counts or dates from the owner's data. Those are in the owner's
Cloudflare dashboard and, for notes, in `docs/private/STATUS.md` (a private repo checked out
there, gitignored here). If that folder exists, read it too.

## Fork integration status

This fork retains its expanded Bills page and has integrated independent upstream features
through `72bfcd9`. Applied migrations 0001–0013 are unchanged; 0014 is the additive bridge.
See [upstream-integration.md](upstream-integration.md). The historical upstream notes below
describe the author’s rollout and may differ from this fork.

## Where things stand

- **Code:** Minty is Cloudflare-only (a Worker plus D1, on free plans); everything through #59 is
  on `main`. CI (vitest in workerd + typecheck) runs on every PR, and Workers Builds deploys
  `main`. **Tests: 337** (2026-10-15, ee99fa8). Migrations 0001–0009.
  - Plan and decision log: [serverless-plan.md](serverless-plan.md) §8. ABC: [abc.md](abc.md).
    Finance agent: [agent-plan.md](agent-plan.md). Live demo: [demo.md](demo.md).
    Security: [security-plan.md](security-plan.md).
- **Licence:** PolyForm Strict 1.0.0 since #39 (source-available: use unmodified, noncommercial;
  no changes or redistribution). Copies taken before #39 keep MIT. The old Python/Docker app is
  the `tailscale-selfhosted` branch and the `python-app-final` tag, both moved to PolyForm Strict
  on 2026-10-13. Untested, and linked from GET-STARTED for people with a home server.
- **The owner's household deployment:** imported from `rg-code/minty` with Workers Builds
  (deploy command `npm run deploy`), Access enabled, Setup checks all ✓, on Plaid production.
  Preview URLs are off (dashboard, and `"preview_urls": false`); the production branch is `main`.
  Details and history: `docs/private/STATUS.md`.
  - Lesson from setup: Access's policy (who can sign in) and the Worker's `ALLOWED_LOGINS`
    (who the Worker accepts) are separate lists; a login must be on both.
  - **`TOKEN_ENC_KEY`** is kept in a password manager. Losing it means re-linking every bank.
  - **D1 rows read:** the free daily quota ran out once, because ABC read hundreds of thousands
    of rows a request. Fixed in #32 with indexes and a per-route read budget
    (`test/reads.test.ts`).
- **For friends:**
  - **Landing page:** https://minty.milesmaximizer.com. Its code is in its own private repo,
    which rebuilds the demo from this one.
  - **On the landing page:**
    - **Get started** opens [GET-STARTED.md](../GET-STARTED.md) in a side panel, and **Try the
      live demo** runs the demo in another. There are fork and clone links, but no ZIP, since a
      ZIP copy never updates.
    - **Support Minty** (top right) opens a menu: donations, referral links, Star on GitHub, and
      sharing the repo.
    - **Three raised cards:** Share, Support and Contact me. Contact me is a form that emails
      the owner without showing any address on the page.
    - **GoatCounter** counts visits and clicks.
  - **Forks:** they update themselves every Monday (#41), after the one-time "enable workflows"
    click in each fork. Security step 6 changes this to signed release tags.

## Recently done (2026-10-10 to 10-14)

- **Security step 3, Link sessions (#57, migration 0009).** `/link/token` reserves a slot per
  login, and `/link/exchange` claims that session once before Plaid's exchange, taking owner and
  slot from it, never from the browser. New `POST /link/cancel`; a one-a-minute cooldown on
  reconnects. Linking looks the same.
- **Device lock (#58):** Face ID, Touch ID, Windows Hello or a fingerprint before Minty shows
  anything, on by default where the device has a built-in authenticator, never locking anyone
  out where it hasn't. A visibility gate only (WebAuthn on the device; nothing in D1). Stripped
  from the live demo.
- **The coin (#59):** while a sync request is pending it drops and bounces on the ground,
  instead of spinning.
- **Security review (2026-10-14).** No unauthenticated path to financial data. Plan, decisions
  and to-do: [security-plan.md](security-plan.md). Step 1 done the same day: a ruleset on `main`,
  preview builds off and a narrower build token, an Emails Access policy. Step 2 (#54): rate
  limits per login, a 16 KiB body cap, a daily D1 read budget, and searches longer than 48
  characters no longer fail.
- **Phones (#46):** the dashboard header no longer pins half the screen.
  - It scrolls away, and a small strip pinned to the top takes over: the coin (back to top), the
    current person, and icon buttons for search, tags, banks, cards and dates.
  - The same controls move into it and back, so filters keep working. Desktop is unchanged.
- **Demo people (#47):** Kate, Adam, Andy and Maurice, one transaction each; 497 transactions,
  inside the 500 cap.
  - Dashboard fix from it: with four or more people, the person switch scrolls sideways on phones.
- **Landing page:** it moved to its own repo (#48 updated the docs), gained the Support menu,
  the cards and the contact form, and lost the ZIP download. The demo build takes optional
  link-preview tags (#51).
- **Sync (#27):**
  - Stalled downloads restart from where the update began (`items.sync_start_cursor`).
  - A 10-minute catch-up trigger continues unfinished downloads.
- **Bank problems are never silent (#28):** a status strip on the dashboard and the same lines in
  Setup checks (`src/health.ts`), plus a daily `/item/get` check that records consent end dates,
  so the strip warns about a week before one ends.
- **ABC, "All but coupon clipping" (#30–#33):**
  - A popup listing every card credit, used and still open, checked against statement credits.
  - Covers the cards in `src/benefits/catalog.ts`.
  - #32 fixed the read quota; #33 counts credits that post as a merchant refund.
- **Dashboard:**
  - **Look:** a Dates menu and a tidier ABC (#34), a mint background (#35), the coin logo (#36).
  - **The coin (#37):** click it to refresh and request a sync (recorded only; the next cron run
    syncs). Also Show more past 500, and "Last synced".
  - **Install as an app (#40):** Chrome, Safari and Edge, with Samsung Internet handled.
- **Onboarding:** GET-STARTED.md, a one-page guide for anyone (#38, #42, #43, #50). The licence
  change (#39). Weekly fork sync (#41).
- **Live demo (#44):**
  - **What it is:** the real dashboard and Worker in the browser over sql.js. About 500 made-up
    transactions, a working ABC, and a coming-soon "AI connector" dialog.
  - **Speed:** about 0.8 s from click to transactions.
  - **Upkeep:** rebuilt and published with the landing page.

## To do, in order

1. **Security plan, step 5** (rotation and disconnect, [security-plan.md](security-plan.md) §3–§4; 5a done),
   in three PRs: 5a encryption-key rotation, 5b disconnect a bank, 5c Plaid token rotation. Then
   step 6. Steps 1–4 are done (settings and docs; rate limits and the D1 budget, #54; Link
   sessions, #57; browser headers, report-only in #61 and enforced on 2026-10-16).
2. **Quick checks on the live deployment** (the owner, in the dashboard):
   - **CPU:** **Worker → Metrics** for "Exceeded CPU", especially `/benefits` and the catch-up
     runs.
   - **D1 rows read:** **D1 → minty → Metrics** after a day of normal use with ABC. The budget
     is 5,000,000 a day.
   - Household-specific checks: `docs/private/STATUS.md`.
3. **ABC coverage.** Cards ABC doesn't know show as untracked; add the ones the household holds
   to `src/benefits/catalog.ts`, with sources and `CHECKED`. Re-check the existing benefits when
   issuers change them; the last check was 2026-10-12.
4. **CFA (Complete financial audit) and EGG (retirement accounts)**, [cfa.md](cfa.md).
   - **Decided:** CFA keeps its name, the retirement button is EGG, HSAs count as retirement
     accounts, the profile is optional, and Schwab is linked first.
   - **Done:**
     - R0: Investments is on the Trial plan; Schwab access is automatic.
     - C1: buckets, monthly totals and daily balance snapshots, kept by the hourly cron.
     - C2: the CFA popup in the ⋯ menu (cash flow and savings rate, categories, recurring
       charges, fees and debt, net worth, corrections).
     - E1: retirement accounts from Plaid Investments (a new login, or added to a bank already
       linked), the cron's daily fetch, and islanding from the dashboard.
     - E2: the EGG view (trend, forecast, this year's contributions against the IRS limits, mix
       and cash, accounts, profile).
   - **Next:** C3 (recommendations and the planner's checklist). The owner checks E1 on Plaid
     Sandbox; the IRS limits need next year's figures each autumn (`src/retirement/limits.ts`).
5. **BAM (Balance of Award Miles & points)**, [bam.md](bam.md).
   - **Done:** M1 (typing balances in, with history), M2 (statement PDFs and the folder shared
     with Bills, Amex Membership Rewards first), and M3's expiry rules and "likely earned by"
     cards.
   - **Next:** more programs' statement layouts, modelled on real PDFs (tests use made-up text).
6. **Decide where MCP goes.** The live demo shows an "AI connector (MCP), coming soon" button, but
   [agent-plan.md](agent-plan.md) has the MCP server as optional phase **A7**. The options:
   - move MCP earlier, as a read-only server built on A1's query tools, so Claude Desktop and
     similar apps can use it before the chat panel exists; or
   - relabel the demo's button "Ask Minty (coming soon)".
7. **The finance agent ("Ask Minty").** Its to-do is §11 of [agent-plan.md](agent-plan.md), and
   its decisions were made 2026-10-06. **Next: A0** (§8.1). It needs the owner's go-ahead plus an
   OpenRouter key (training off) and a Workers AI token in `.dev.vars`.
8. **Landing page and demo upkeep:** after dashboard changes, rebuild and publish the landing
   page so the demo follows. A dashboard change the demo can't follow stops the build, by
   design. Other landing-page to-dos: `docs/private/STATUS.md`.
9. **Owner housekeeping:**
   - Delete unused `PLAID_*` secrets that Setup checks flag, and set `MINTY_USERS` to show your
     name. Keep the existing person keys: banks are stored under them.
   - **Wrangler logins:** `npx wrangler logout` on machines that don't need Cloudflare access.
   - **Plaid Sandbox end-to-end:** the owner runs `node scripts/sandbox-e2e.ts` against
     `npm run dev`, because it reads `.dev.vars`.
   - Other housekeeping: `docs/private/STATUS.md`.
10. **Ongoing:**
   - **Keep Cloudflare's "Update your Wrangler configuration" prompt unapplied:** `keep_vars`
     already preserves dashboard variables, and copying them into `wrangler.jsonc` would publish
     the household's emails and Access IDs.
   - **Each new bank uses a Plaid Trial slot for good** (10 per credential set; removing a bank
     doesn't give it back), so link only banks you'll keep.
   - **Workflows:** a change under `.github/workflows/` breaks every fork's next automatic sync
     until its owner clicks Sync fork, so only make one when it's worth that, and say so in the
     PR.
   - **Deploys:** if a merge doesn't show up live, check **Workers & Pages → minty → Builds** and
     retry the build.
   - **CPU after linking a bank with a long history:** an overrun is safe, because each page
     commits with its cursor. If overruns become frequent, lower `SYNC_MAX_BYTES_PER_RUN`, or move
     to Workers Paid and raise it.
   - **Household notes go in `docs/private/`**, never in this file.
11. **Later:**
   - Onboard friends with GET-STARTED.md, and fix anything they trip on.
   - Email or push alerts for bank problems (they'd need an outbound mail setup).
   - Several Plaid Trial accounts per person is a Plaid ToS gray area. One paid Plaid account per
     person is the cleaner long-term option. Deferred, not forgotten.

## Picking up on a new machine

    git clone git@github.com:rg-code/minty.git && cd minty
    git clone <your private notes repo> docs/private     # optional; gitignored
    npm ci                       # Node 22+; if npm 10 errors resolving new deps, use npx npm@11
    npm test && npm run typecheck
    npm run db:migrate:local && npm run db:seed:local && npm run dev:demo   # http://localhost:8787, two demo people
    npm run build:demo           # the live demo, in dist/demo (serve that folder at /demo/)

- **Cloudflare CLI** (optional; the dashboard is enough): `npx wrangler login`.
- **Temporary QA accounts:** `npx wrangler deploy --temporary` works for Workers + D1. It can't
  run cron or migrations there. See serverless-plan.md §8.
- **The landing page** is in its own private repo, checked out next to this one (its name and
  deploy command: `docs/private/STATUS.md`).
