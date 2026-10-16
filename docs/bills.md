# Bills & statements

Open **Bills** from the dashboard for a household overview of USD credit cards and manually
tracked USD bills. Filter by person and choose **7 / 14 / 30 days** (30 by default). Actual card
payment dates and unmarked manual bills appear in date order; today is included. Past dates
appear in **Earlier payment dates**, including statements with payments already observed.
This is a history section, not an unpaid-bill list. Passing a date never proves that a card is unpaid or that
autopay is disabled.
When payment coverage is incomplete, a card's original due date is labeled as a reported
date. Its original statement amount is prominent, labeled **Original statement**, with
**Remaining unverified** beneath it and observed payments shown separately. **Payment observed** (or **Likely payment observed**)
does not confirm issuer allocation. A zero reported minimum alone does not mark it covered.

**Coming up** always shows totals for the **next 7 days** and **next 30 days**, independently
of the calendar/list period. Both include today through their endpoint; the 7-day total is
part of the 30-day total. They combine **estimated remaining full statement amounts** with
unpaid manual bills in USD. Incomplete totals are labeled **Partial full-payment estimate**.
When no full-payment amounts are usable, the tile shows **Reported card minimums only**
as a reference, with the number of cards contributing if some minimums are missing.
Minimums may already have been met; they are never added to full statement amounts.
An unknown minimum stays unknown, while a reported zero remains zero. Only a period with
no reported dates says so. Expand the excluded/unverified statement count for the actual
coverage reasons. Cards with incomplete calculations stay visible with their original
reported statement amount; missing due dates stay in **Needs attention**.
The calendar places reported or estimated statement dates alongside payment dates; select
a day for details. Toggle **Statements** and **Payments & bills** independently to show
either kind, both, or neither. These controls filter only the calendar and its selected-day
details; payment totals and the rest of the overview stay unchanged. Both kinds are shown
by default.

In **Coming up**, optionally hide cards with zero or negative current balances, or enable
**Hide amounts below** and enter a cutoff (starts at $100). The cutoff uses each card's
current balance and each manual bill's amount; an amount exactly at the cutoff stays
visible. Unknown, non-USD, or outdated card balances remain visible. These controls only
hide rows in Coming up: payment totals, calendar, attention, and past-date review are
unchanged. A hidden count makes the filtering visible; **Show all** turns both filters off.
The settings are saved in this browser, with no account data stored in the preference.

The page assumes USD without repeating currency labels throughout the interface. Other
currencies remain stored but are excluded from this page; no conversion is performed.

## Card names and endings

The statement timeline's card picker groups cards alphabetically by issuer, then by their
display name (including saved nicknames). Numbers sort naturally, so matching card names
stay together with their endings in numeric order. Other lists keep their existing date order.

Choose **Edit name** on a card to save a custom name and an optional four- or five-digit
ending. Amex uses Plaid's four digits by default; enter the last five digits yourself if
you prefer to show those. Minty never guesses the fifth digit. **Use defaults**, then
**Save name**, clears your overrides. Names and endings follow the card across the calendar,
payment list, attention list, and statement history, and survive bank refreshes.

Default Chase labels use **Chase** plus the ending. Other default labels shorten
**Business** to **Biz**, **Platinum** to **Plat**, and **Charles Schwab** to **Schwab**,
and remove **Card** and trademark/service marks. Custom names stay as entered. These
are display preferences; bank-reported names and account masks remain unchanged.

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
- Recognized American Express charge products (such as Gold and Platinum) omit utilization.
  They also omit a zero or missing credit limit; a positive supplied value appears as
  **Reported limit**, without treating it as a revolving credit limit. Classification uses
  the bank-reported institution and a narrow product-name list, never your nickname or a
  missing limit alone. Amex revolving products, including Delta Gold/Platinum, retain their
  credit limits and utilization. Unrecognized product names retain the ordinary display.
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

For an existing connection, choose **Verify payment history** under Bank connections.
Each click checks one page of Plaid's available transactions for the saved statement periods
and the frozen set of saved accounts. Unrelated account metadata does not change that scope;
**Continue history verification** resumes the next page. It compares IDs, dates, amounts,
accounts, pending status, and payment classification with the saved records. Changed data,
missing records, duplicates, a stale connection, or a moving sync cursor prevent verification.
Older saved transactions may be missing classification fields introduced by Bills. For an
otherwise exact matching record, verification fills only missing category, detailed category,
and confidence from Plaid's available metadata. Existing populated values are never overwritten;
conflicts still prevent verification. Source classification can identify a previously unknown
payment, exclude a refund that resembled a payment, or lower its confidence. All three changes
flow through the normal payment calculations.
If a primary category is filled, the same transaction marks the cached financial audit for
its normal background rebuild. Detail or confidence repairs alone do not request that rebuild.
Each page rechecks its records, ownership, source freshness, cursor and verification lease in
the same database transaction that fills metadata and saves page progress. A failing page
cannot partly save metadata or progress, and raw source pages are deleted in that transaction.
Successfully checked earlier pages may retain their metadata if a later page fails; coverage
still requires a successful check of the complete transaction set.
Failure messages distinguish missing or changed records, account mismatches, and Plaid's
bank-update status, and remain visible after a reload. A normal transaction fetch reads
Plaid's cached data; it does not force a new bank update or replay unchanged older records.
Repeated fetching therefore may not resolve a persistent mismatch. Nothing is marked
verified until every page matches and the final checks succeed. Existing transaction IDs,
amounts, dates, descriptions, tags, sync cursors, sync timestamps and original coverage
boundaries stay intact. Missing source classifications remain unknown.
If a later check fails or is still running, estimates that relied on the earlier check
remain withheld until the new check finishes. The saved interval is retained for diagnosis.

This records a separate checked interval and source, rather than backdating the original
history boundary. It must overlap the ongoing sync coverage before older statement estimates
become usable. The UI says **History checked against all transactions available from Plaid**:
the bank can provide limited history, so this is not proof of issuer completeness or payment
allocation. Remaining amounts retain their **Estimated** labels.

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
`0012_card_display_preferences.sql` stores display names and ending overrides separately
from the bank data, keyed by the existing connection and bank account.
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

This fork's weekly updater prepares a normal upstream merge and runs the full checks
before publishing it. Conflicts, workflow changes, and migration collisions stop for
review. See [Automatic fork updates](fork-updates.md) for activation and test-only runs.
Never force-sync the fork and discard its custom features.

## API

- `GET /liabilities?owner=` returns banks with shared connection health and all credit cards,
  including cards without Liabilities. Cards include balance/limit inputs, `is_charge_card`,
  current utilization (null for recognized charge cards),
  statement forecasts, and payment summaries with confidence and coverage reasons.
- `GET /liabilities/history?account_id=&before=&owner=` returns up to 50 saved statements,
  their payment summaries, and `next_before`. Here `account_id` is the statement-card ID,
  not the separate transaction-account ID. Account-only cards have no statement-card ID.
- `GET /liabilities/payments?statement_id=&before=&owner=` returns up to 50 detected payments
  for a statement with evidence, descriptions, amounts, and dates. `next_before` is an opaque
  `date:id` cursor for the next page. Corrections/removals can change results between reads.
- `POST /link/token/liabilities {item_id}` and
  `POST /link/liabilities/complete {session_id}` handle explicit statement access.
- `POST /liabilities/verify-history?owner= {item_id}` checks one bounded history page.
  The overview's banks include sanitized `history_verification_status` and
  `history_verification_code`, plus the separately recorded verified interval and timestamp.
  Internal cursors, provider account IDs, and source payloads are not returned.
- `POST /liabilities/card-display?owner=` saves `nickname` and `display_mask` for exactly one
  `transaction_account_id` or `card_id`. Both preference fields are required and accept
  `null`; both `null` restores defaults. Names are at most 80 characters without control
  characters; ending overrides are four or five digits. Overview and history card metadata
  return these preferences without exposing provider account IDs.
- `GET /manual-bills?owner=`, `POST /manual-bills`, and
  `POST /manual-bills/:id/paid`, `/archive`, `/restore` manage manual bills.

All read endpoints retain Access authentication, rate/read limits, optional owner filtering,
and no-cache behavior. Payment queries are bounded; hitting a review limit produces incomplete
coverage instead of a complete-looking partial estimate. Monetary fields use integer cents
and dates use `YYYY-MM-DD` without timezone conversion. Statement currency is kept separately
from a more recently observed current-balance currency; no exchange-rate conversion is applied.
