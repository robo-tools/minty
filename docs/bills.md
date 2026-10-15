# Bills & statements

Open **Bills** from the dashboard for a household overview of credit cards and manually
tracked bills. Filter by person and choose **7 / 14 / 30 days** (30 by default). Actual card
payment dates and unmarked manual bills appear in date order; today is included. Past dates
have a separate review section. Passing a date never proves that a card is unpaid or that
autopay is disabled.

Totals combine **estimated remaining full statement amounts** with manual bills, separately
for each currency. Reported card minimums are a separate reference and are never added to
full statement amounts. Cards with incomplete calculations stay visible with their original
reported statement amount and an explanation that the amount is excluded from totals.

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

## Balances, statements, and payment estimates

- **Current balance and credit limit** come from the most recent stored account response.
  Linked credit cards remain visible even when statement access is disabled.
- **Current utilization** is `max(current balance, 0) / positive reported credit limit`.
  Missing or zero limits give **Unknown**; credit balances give zero utilization; balances
  above the limit can exceed 100%. This is not credit-bureau utilization.
- **Original statement balance** is the amount on the issued statement. It is not a live
  remaining balance or proof that no payment has been made.
- **Reported minimum** and **payment due date** are the issuer's latest fields. Minty does
  not infer autopay or paid status. Only the issuer's overdue flag is described as overdue.
- **Estimated remaining full statement** is
  `max(original statement balance - included posted card payments, 0)`. The original
  amount, observed payments, and result appear together. Zero is **Estimated covered**,
  not an issuer confirmation that the statement is paid. Excess payments do not carry
  forward to another statement's calculation.
- Missing fields are **Not reported**, never silently zero. Stale, failed, or unavailable
  details remain visible with a warning; an unavailable estimate is excluded from totals.
- The timeline grows from dated statements observed after tracking starts. It cannot
  recover all older statements and does not download PDFs. Corrections update the same
  statement date; later null fields do not erase known historical values.

Payments are detected only on that credit card's transaction feed. A posted negative amount
with Plaid's credit-card-payment classification is stronger evidence; lower classification
confidence and clear payment descriptions are **likely matches**. Both are included
automatically, with likely counts and amounts shown. Pending transactions, purchases,
refunds, rewards, and identified payment reversals do not reduce the estimate. Currency
must match the statement. Each transaction is counted once. A checking-account debit and
Liabilities' separate last-payment field are never also subtracted. The last-payment field
is supporting information; disagreement with the observed feed is flagged.

The payment window starts **after** the statement issue date and ends **on** the next
reported issue date, or today for the latest statement. A transaction on a new statement's
issue date belongs only to the previous window. These are **payments observed after the
statement**, not issuer-confirmed allocations. Minty recalculates from the current transaction
rows when reading the page, so Plaid modifications and removals affect the calculation.
Returned payments and ambiguous reversal matches require review rather than a confident
covered result. Minty also checks later posted returns through today: a return with a matching
amount and currency removes a probable earlier payment from the calculation and withholds
that statement's estimate, even across a statement boundary. This is conservative evidence,
not a confirmed match; an unmatched later return does not invalidate unrelated older windows.
A transaction named “autopay” describes that past payment only; this feature
does not configure or infer future autopay, its amount, or its funding account.

## Coverage, forecasts, and attention

Estimates require a complete, fresh transaction feed covering the statement window and
usable statement details. A caught-up sync cursor alone does not prove that historical
transactions have finished downloading: Plaid must report `HISTORICAL_UPDATE_COMPLETE`.
Downloading, stale, unavailable, missing-date, currency, and bounded-review conditions are
explained with the calculation. Detected payments may still be displayed, but Minty withholds
the remaining estimate while coverage is incomplete. Transaction freshness uses the same
bank-health checks as the existing dashboard; statement details need updating after 30 hours.

New connections request up to 730 days of transaction history and retain the requested start
date. Coverage is established only after the download completes. Existing connections whose
requested boundary was not previously stored start their provable coverage on the first
historical-complete sync after this migration. Their earlier rows and cursors are preserved,
but seeing old transactions does not by itself prove full coverage. Consequently, older
statement estimates can remain unavailable while later statements become eligible. This
migration does not reset a cursor or force a full redownload.

**Next statement · Estimated** advances the last reported issue date by one calendar month,
clamping short months. Two most recent month-end statements establish a month-end pattern.
A newly reported statement replaces the prior prediction. Forecasts have no predicted
amount and never contribute to payment totals; they are not bank-confirmed future dates.

**Needs attention** brings together bank-reported overdue status, payment dates within seven
days, existing connection/freshness warnings, missing due dates, incomplete history, likely
payment matches, and last-payment discrepancies. It does not guess whether autopay is active.

## Other bills

This version supports credit-card Liabilities. Add rent, utilities, loan payments, and other
obligations manually. Manual bills can repeat monthly; marking one paid records a note and
advances one month, preserving the original day across short months. It never pays a bill.
One-time bills remain marked paid. Archive/restore hides and restores a bill without erasing
its payment records. Card-payment detection does not require routine manual payment entry.
All authorized household logins can view and manage all bills, matching Minty's existing
trust model; the person filter narrows the view rather than creating a separate permission.

## Deploy and develop

`npm run deploy` applies the additive migrations before publishing the Worker.
`0010_card_statements.sql` stores statement history and manual bills;
`0011_bill_payment_coverage.sql` adds account limits, detailed transaction categories/confidence, and
explicit transaction-history coverage metadata. Existing rows and sync cursors are preserved.
Existing banks remain disabled for Liabilities until the user opts in. Three cron
triggers are used: the existing two transaction jobs and `3,13,23,33,43,53 * * * *` for Bills.
No new secrets are needed. The existing Access, same-origin, request-size, and rate limits
protect the new endpoints. API responses use `Cache-Control: no-store` and are never
service-worker cached. Development, draft-PR review, production deployment, and each bank's
Plaid consent are separate steps; reviewing this feature does not activate production access.

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

## API

- `GET /liabilities?owner=` returns banks with shared connection health and all credit cards,
  including cards without Liabilities. Cards include balance/limit inputs, current utilization,
  statement forecasts, and payment summaries with confidence and coverage reasons.
- `GET /liabilities/history?account_id=&before=&owner=` returns up to 50 saved statements,
  their payment summaries, and `next_before`. Here `account_id` is the statement-card ID,
  not the separate transaction-account ID. Account-only cards have no statement-card ID.
- `GET /liabilities/payments?statement_id=&before=&owner=` returns up to 50 detected payments
  for a statement with evidence, descriptions, amounts, and dates. `next_before` is an opaque
  `date:id` cursor for the next page. Corrections/removals can change results between reads.
- `POST /link/token/liabilities {item_id}` and
  `POST /link/liabilities/complete {session_id}` handle explicit statement access.
- `GET /manual-bills?owner=`, `POST /manual-bills`, and
  `POST /manual-bills/:id/paid`, `/archive`, `/restore` manage manual bills.

All read endpoints retain Access authentication, rate/read limits, optional owner filtering,
and no-cache behavior. Payment queries are bounded; hitting a review limit produces incomplete
coverage instead of a complete-looking partial estimate. Monetary fields use integer cents
and dates use `YYYY-MM-DD` without timezone conversion. Statement currency is kept separately
from a more recently observed current-balance currency; no exchange-rate conversion is applied.
