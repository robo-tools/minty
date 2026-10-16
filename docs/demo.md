# Live demo

The landing page (https://minty.milesmaximizer.com, **Try the live demo**) runs Minty with
made-up data: the real dashboard (`public/index.html`, `app.js`, `theme.js`, `abc.js`, `abc.css`) and the real Worker
(`src/`), both in the visitor's browser. There's no server behind it: nothing is sent anywhere,
Plaid is never called, and everything resets on reload.

## How it works

- `demo/main.js` runs first on the page. It downloads **sql.js** (SQLite compiled to WebAssembly,
  1.13.0 from cdnjs, about 290 KB compressed; both files are checked against pinned hashes),
  applies `d1/migrations/` to an in-memory database and loads the household from
  `demo/data.ts`.
- It patches `fetch`: the API paths from `wrangler.jsonc` `assets.run_worker_first` go to the
  Worker's own `fetch` handler in the page (as a `localhost` request with `MINTY_DEV_NO_AUTH`, so
  the Access check passes without a JWT), with `demo/d1.js` standing in for D1. Requests to Plaid
  are refused.
- **Clicking the logo** records a sync request, as in Minty. The demo's "cron" runs 40 seconds
  later: a new purchase appears, and the dashboard's next check (within a minute) loads it.
- **AI connector** (demo only, coming soon): a dialog with four example questions. The answers
  are worked out from the demo's data; nothing is connected.
- The fork’s standalone Bills page is tested separately with fictitious data; it is not part of this transaction demo.
- Links that need a real Minty (`/connect`, `/add-user`, `/status`) show a note instead.
- The demo opens in light mode, registers no service worker and has no install prompt.

## The data

`demo/data.ts`: a made-up household, Alex and Sam (plus Kate, Adam, Andy and Maurice, with one
transaction each), generated in the browser relative to the
visitor's date (the same for a given day). About 500 transactions, kept small so the demo starts
fast: everyday spending, bills and pay for the last 160 days, and card credits back to last
January 1, planted so ABC shows used, partly used,
missed, open and tick-box credits on an Amex Platinum, an Amex Business Gold and a Citi Strata
Premier. One bank (Ally) has access through Plaid that ends in 5 days, so the health strip has
something to show.

Nothing in it is real: no emails, made-up last-4 digits, invented employer, landlord and
restaurants. Bank, card and big-merchant names are real because ABC recognises cards and credits
by them. `test/demo.test.ts` checks this, loads the data into the test D1 and reads it back
through the real routes.

## Build

    npm run build:demo -- --out <folder> [--goatcounter https://<code>.goatcounter.com/count] \
                          [--og-image https://<site>/og.png --og-url https://<site>/demo/]

Writes a static folder (default `dist/demo`, not committed). `--og-image` and `--og-url` add link-preview
tags (Slack, iMessage…) for wherever it's published; the image must be a PNG or JPEG. Each change the build makes to
`public/index.html`, `app.js` and `theme.js` is checked, so when the dashboard changes in a way the demo can't follow, the
build stops with the edit that no longer applies. Rebuild and redeploy the landing page after
dashboard changes: it's in its own private repo, rg-code/minty-site (`node deploy.mjs` there; see its README).
