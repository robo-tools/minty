<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/minty-logo-dark.png">
    <img src="brand/minty-logo.png" alt="Minty" width="340">
  </picture>
</p>

# Minty — a personal transaction aggregator

**Want your own? Start here: [GET-STARTED.md](GET-STARTED.md)** (about 10 minutes, free, all in a browser).

**See it first:** the [live demo](https://minty.milesmaximizer.com/#demo) runs Minty with made-up data, in your browser ([how](docs/demo.md)).

Minty pulls transactions from your household's banks and cards via Plaid into one private
dashboard, with tags, search and per-person totals. Each household runs its own copy on
Cloudflare: one Worker plus a D1 database, on free plans, with no server to look after.
Your data and keys stay in your own Cloudflare and Plaid accounts.

**Want your own?** Fork this repo and follow [SETUP.md](SETUP.md). Everything is done in a
web browser.

## How it works
- **Worker** (`src/`): serves the API behind Cloudflare Access, holds the Plaid keys, and is the
  only thing that talks to Plaid. Pages (dashboard, connect, add user) are static files in
  `public/`.
- **D1** (`d1/migrations/`): items (bank logins), accounts, transactions and tags. Migrations
  are tracked and applied automatically on every deploy.
- **Sync**: an hourly cron trigger pulls new transactions with Plaid's cursor-based
  `/transactions/sync`, and a 10-minute one continues banks still downloading their history.
  Linking a bank starts its first sync right away. A daily check asks Plaid how each connection
  is. Any bank that stops syncing, needs signing in again, or has consent ending soon shows in
  a status strip on the dashboard, with what went wrong and what to do. There is no sync HTTP
  endpoint and no webhooks.
- **ABC ("All but coupon clipping")**: a popup on the dashboard listing every monthly,
  quarterly and annual credit on your cards (Amex Platinum, Business Platinum and Business Gold,
  Citi Strata Premier, Altitude Reserve), with what's used and what's still open, checked
  against the statement credits. See `docs/abc.md`.
- **Deploys**: Cloudflare Workers Builds runs `npm run deploy` on every push to `main`
  (apply D1 migrations, then deploy). GitHub Actions only runs tests.
- **Bills & statements**: a dedicated page for card balances, reported payment dates,
  observed statement history, and one-time or monthly manual bills. Bank statement details
  are opt-in through Plaid Liabilities. See [docs/bills.md](docs/bills.md) for setup and limits.

## People and the trial overflow model
People come from the `MINTY_USERS` variable, `key:Name` in display order. The default is one
person, `me:Me`; with two or more (e.g. `me:Alex,sam:Sam,kim:Kim`), the dashboard shows a person
switch: **Combined**, then each name. Each person has their own Plaid Trial credential sets, a
**primary** and a **backup** by default (`PLAID_SLOTS`):

    me_primary  → me_backup   (owner: me)
    sam_primary → sam_backup  (owner: sam)

`owner` drives the dashboard's filtering and totals; `plaid_account` is the credential set a
bank login is bound to. New links land on the person's primary; when it reaches
`TRIAL_ITEM_CAP` (10) logins, the next link overflows to their backup. The connect page shows
how full each trial is. To add someone, open **+ Add user**: it lists the `MINTY_USERS` value and
the secret names to add in the Cloudflare dashboard.

> Note: multiple Trial accounts per person to extend the free item cap is ToS gray area.
> The clean alternative is one paid Plaid account per person (no cap). Your call.

## Security model
- **Every login you admit is fully trusted.** Anyone who passes Access (and `ALLOWED_LOGINS`)
  can see every person's banks and transactions, change tags and card settings, and link or
  reconnect banks. The person switch is a view, not a permission. Admit only people you'd hand
  your whole household's finances to.
- **Cloudflare Access** decides who can sign in to the hostname at all.
- **The Worker re-checks the Access token** on every API request, and optionally an
  `ALLOWED_LOGINS` allow-list. If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing, every API
  request is refused. A refusal says which check failed. `/healthz` is the only open path.
- **Cross-site writes are refused**, so another site can't act through a signed-in browser.
- **Limits per login:** 120 API requests a minute, 30 searches or ABC loads, 10 bank-linking
  calls (approximate: Cloudflare counts per location). Request bodies are capped at 16 KiB.
  A daily D1 read budget pauses browsing and search before Cloudflare's free quota runs out,
  so sync keeps working.
- **Plaid access tokens are Fernet-encrypted** with `TOKEN_ENC_KEY` before they're stored.
  Plaid keys and `TOKEN_ENC_KEY` are Worker secrets; they never reach the browser or the database.
- **Setup checks** on the Add user page show what's configured, never the values.
- **Device lock:** on a phone or computer with Face ID, a fingerprint sensor or Windows Hello,
  Minty offers to ask for it before showing anything (`public/lock.js`). It hides the screen from
  someone holding your unlocked device; it doesn't protect the data, and never talks to the
  Worker. Turn it off per device under Add user → This device.

## Endpoints
    GET  /                       dashboard
    GET  /bills                   balances, payment dates, statement timeline and manual bills
    GET  /connect                link a bank/card
    GET  /add-user               setup checks + the values to add a person
    POST /link/token             {owner} -> {link_token, plaid_account, session_id, expires_at}   (reserves a slot for 30 min)
    POST /link/exchange          {session_id, public_token}   (owner and slot come from the session; starts the first sync)
    POST /link/cancel            {session_id}   (Link closed: the reserved slot goes back)
    POST /link/token/update      {item_id} -> {link_token, session_id, ...}   (reconnect a bank; once a minute per bank)
    GET  /items                  linked institutions + status
    GET  /accounts               accounts + balances + card members   (?owner=)
    GET  /transactions           unified feed   (?owner= &tag= [repeatable] &tag_mode=any|all &q= &start= &end= &item_id= [repeatable: banks] &account_id= [repeatable: cards / accounts] &card= [repeatable: account_id:card member])
    GET  /tags                   distinct tags in use
    PUT  /transactions/{id}/tags {tags:[...]}  replace a transaction's tags
    GET  /capacity               per-person trial usage (used/cap)
    GET  /users                  people from MINTY_USERS + which key slots are set (no secrets)
    GET  /status                 setup checks (no values)
    GET  /healthz                liveness (ungated)

## Development
    npm ci                                              # Node 22+
    npm test                                            # workerd + local D1, no network
    npm run typecheck
    npm run db:migrate:local && npm run db:seed:local   # demo data
    npm run dev                                         # http://localhost:8787 (Access bypassed, localhost only)
    npm run dev:demo                                    # same, with two demo people (Alex, Sam) for the seed data

Against Plaid Sandbox: put Sandbox keys and a `TOKEN_ENC_KEY` in `.dev.vars` (see
`.dev.vars.example`), start `npm run dev`, then run `node scripts/sandbox-e2e.ts`.
To run the cron sync by hand locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+*+*+*+*"`.

## Notes
- Plaid amount sign: POSITIVE = money out, stored as integer cents. The dashboard flips it.
- Plaid returns the account **mask** (last 4), never the full number.
- Tags are separate rows that sync never touches, so labels survive re-syncs.
- On the free plan a new bank's history backfills about 100 transactions per hourly run
  (10 ms CPU limit). Workers Paid can raise `SYNC_MAX_BYTES_PER_RUN`.
- Minty started as a Python/Docker app; its last version is tagged `python-app-final`.

Status and next steps: [docs/STATUS.md](docs/STATUS.md).

## License

Minty is **source-available**, under the [PolyForm Strict License 1.0.0](LICENSE). It's not
open source. In short (the [LICENSE](LICENSE) text is what counts):

- **You may:** fork or clone it, read and review the code, and run it **unmodified** for your own
  personal or household use, or any other noncommercial purpose.
- **You may not:** change it or build on it (in a fork or anywhere else), redistribute it, or use
  it for any commercial purpose.

This covers the Minty name and logo (`brand/`) too. Third-party pieces keep their own licenses;
for example, the Manrope typeface in the logo is under the SIL Open Font License.
