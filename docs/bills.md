# Bills & statements

Open **Bills** from the dashboard for a household overview of credit cards and manually
tracked bills. Filter by person, review the next 30 days, and open a card's statement timeline.

## Enable bank details

Under **Statement connections**, choose **Enable statement details** for each existing bank.
Plaid Link opens in update mode and asks for Liabilities consent. This reuses the connection
and does not consume another trial Item. Minty verifies consent with `/item/get` before
enabling polling; cancelling Link leaves tracking disabled. Unsupported banks can still
provide transactions. The user must approve any new bank permissions in Plaid.

The first opted-in bank is checked at the next ten-minute tick. If several banks are queued,
one runs per tick. Successful banks refresh about daily; temporary failures retry after an
hour. Consent and unsupported-product errors wait for the user to review access. This job
is independent of transaction sync, so a statement failure cannot pause transactions.
Liabilities is included in Plaid's free trial; paid Plaid plans may charge for this product.

## What the numbers mean

- **Current balance** is the balance reported when Liabilities was last checked.
- **Last statement balance** is the amount on the last issued statement. It is not a live
  remaining balance or a promise that no payment has been made.
- **Reported minimum** and **payment due date** are the issuer's latest fields. Minty does
  not infer autopay or paid status. A past date alone does not mean a card is overdue.
- Missing fields are **Not reported**, never zero. Stale, failed, or unavailable card data
  stays visible with a warning and is omitted from the upcoming dates list.
- The timeline grows from dated statements observed after tracking starts. It cannot
  recover all older statements and does not download PDFs. Corrections update the same
  statement date; later null fields do not erase known historical values.

This version supports credit-card Liabilities. Add rent, utilities, loan payments, and other
obligations manually. Manual bills can repeat monthly; marking one paid records a note and
advances one month, preserving the original day across short months. It never pays a bill.
One-time bills remain marked paid. Archive/restore hides and restores a bill without erasing
its payment records. All authorized household logins can view and manage all bills, matching
Minty's existing trust model.

## Deploy and develop

`npm run deploy` applies additive migration `0010_card_statements.sql` before publishing the
Worker. Existing banks remain disabled for Liabilities until the user opts in. Three cron
triggers are used: the existing two transaction jobs and `3,13,23,33,43,53 * * * *` for Bills.
No new secrets are needed. The existing Access, same-origin, request-size, and rate limits
protect the new endpoints. API responses are never service-worker cached.

The standalone static transaction demo intentionally omits Bills. For a local Bills preview
with fictitious data, run local migrations, then:

```sh
node scripts/seed-bills.mjs > .wrangler/bills-seed.sql
npx wrangler d1 execute DB --local --file .wrangler/bills-seed.sql
npm run dev:demo
```

Open `http://localhost:8787/bills`. Fixtures contain no working credentials and have no
scheduled Plaid attempts. Do not apply these fixtures to a production database.

The fork's weekly upstream-sync workflow uses a fast-forward-only sync. Once this feature
is merged, upstream changes may need a normal Git merge into the fork; do not force-sync
the fork and discard its custom features.

API: `GET /liabilities?owner=`, `GET /liabilities/history?account_id=&before=`,
`POST /link/token/liabilities {item_id}`, `POST /link/liabilities/complete {session_id}`,
`GET /manual-bills?owner=`, `POST /manual-bills`, and `POST /manual-bills/:id/paid`,
`/archive`, `/restore`. History uses a 50-statement cursor page. Monetary fields use integer
cents and dates use `YYYY-MM-DD` without timezone conversion.
