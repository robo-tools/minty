# Plan: CFA (Complete financial audit) and EGG (retirement accounts)

**Status (2026-10-16): every phase built** (R0, C1–C3, E1–E2; §5), and the IRS limits are fetched
once a year (§5.7). Next: the owner's Sandbox check of E1.

Two features, planned together because they share their data and charts:

- **CFA, the Complete financial audit:** charts and trends for spending, saving, debt and
  retirement. It finds changes you can act on, and gives the recommendations a financial planner
  (CFP), an investment analyst (CFA) and a wealth advisor would usually make, each one showing its
  arithmetic.
- **EGG, the retirement view** (as in nest egg): retirement accounts (Schwab, Fidelity,
  Betterment, Vanguard, a workplace 401(k), …) in a view of their own. By default they're kept
  out of the dashboard (islanded). Less is more here: a trend, a forecast and very little else
  (§3).

Both are read-only. They never move money, and they never call Plaid on a request (§4).

## 1. What Minty has today, and what's missing

| Have | Missing |
| --- | --- |
| Transactions with Plaid's category (`personal_finance_category.primary`: `INCOME`, `TRANSFER_IN`/`_OUT`, `LOAN_PAYMENTS`, `FOOD_AND_DRINK`, …) | A spend / save / transfer classification that doesn't count a card payment twice, or a move between your own accounts as spending |
| Each account's type, subtype and **current** balance | Balance **history** (needed for every trend line, and for net worth) |
| Card statements, APRs and interest (Liabilities, Bills) | Investment holdings, securities and investment activity (Plaid **Investments**) |
| Bills, ABC credits | A way to link a brokerage: Link asks for `transactions` only today, so a bank that only supports Investments doesn't appear in Link |
| | Charts: the dashboard has none, and the CSP (`script-src 'self'`) rules out a chart CDN |

## 2. CFA, the Complete financial audit

A full page (`/audit`), opened from the dashboard's ⋯ menu, which is where new features go. It
has four sections, each a chart with one line of plain-words findings under it, then the
recommendations.

### 2.1 Charts and trends

1. **Cash flow:** income, spending and saving per month, 12 or 24 months, plus the
   **savings rate** trend.
2. **Spending by category:** each category's last 3 months against its own 12-month average.
   Rising ones are flagged.
3. **Recurring charges:** subscriptions and regular bills found from repeats (same merchant, a
   similar amount, a monthly, quarterly or yearly rhythm), with their yearly cost, price rises and
   likely duplicates.
4. **Net worth:** cash, plus investments, minus card and loan balances, over time. It starts the
   day balance history starts (§4), so it begins with one point.
5. **Debt:** card balances carried over, the interest paid per year, and the APR of each card
   (from Liabilities).
6. **Retirement** (once EGG exists): its total, how much was contributed this year, and the
   forecast summary.

### 2.2 Classification (the part everything else depends on)

Each transaction is put in one bucket, in SQL:

- **Income:** `INCOME`, and `TRANSFER_IN` from outside the household's own accounts.
- **Saving:** a move to your own savings, investment or retirement account (a transfer pair, or
  a contribution).
- **Transfer (ignored):** a move between your own accounts. A **transfer pair** is money out of
  one of your accounts and the same amount into another within 3 days. Card payments
  (`LOAN_PAYMENTS` to a linked card) go here too: the purchases on the card already count as
  spending, so the payment must not count again.
- **Debt payment:** a loan payment to an account that isn't linked (a mortgage or a car loan).
- **Spending:** everything else going out.

You can correct a bucket per merchant, the same way tags work: stored in a table that sync never
writes.

### 2.3 Findings and recommendations

The rules live in code (`src/audit/rules.ts`), like ABC's catalog, each with its threshold, a
source and a `CHECKED` date. Nothing is fetched at runtime. Each finding shows:
- **what** was found;
- **why** it matters, in one line;
- **the estimated effect** in dollars a year;
- **one action** to take;
- **the numbers it used**, so it can be checked.

They're ranked by dollars a year. Examples:

| Area | Finding | Action |
| --- | --- | --- |
| Spending | A category is up 20%+ (and $50+/month) on its 12-month average | Look at its top merchants (a link to the filtered dashboard) |
| Spending | Recurring charges: price rises, duplicates, ones not used lately | Cancel or renegotiate; the list with yearly costs |
| Spending | Fees: bank, ATM, foreign transaction, late fees, card interest | Which account and card, and the yearly total |
| Saving | Savings rate under 15–20% of income | The monthly amount that would reach the target |
| Saving | Emergency fund under 3–6 months of essential spending | The gap in dollars and months |
| Saving | Cash sitting in checking above about 2 months of spending | Move the extra to a high-yield savings account (at a rate you enter, never fetched) |
| Debt | A card balance carried over at a high APR | Pay it off first, highest APR first (avalanche); the interest saved |
| Retirement | Contributions behind the pace for this year's IRS limit | The amount per paycheck to reach it |
| Retirement | The employer match isn't fully captured (from the match you enter) | The contribution % that gets the whole match: "free money left: $X a year" |
| Retirement | High cash in a retirement account (cash drag), for a long horizon | Invest it according to your plan |
| Retirement | One holding over 10% of the total (concentration) | Consider spreading it |
| Retirement | Fees paid inside accounts (investment fee transactions) | The yearly total |

The **planner's checklist** covers things the data can't see, so you tick them. Minty stores the
date each was checked and asks again once a year:
- beneficiaries named on every retirement account;
- a will and other estate documents;
- term life insurance if anyone depends on you, and disability insurance;
- umbrella liability cover;
- a credit freeze at the three bureaus;
- your Social Security estimate (ssa.gov);
- insurance deductibles that fit the emergency fund;
- tax-loss harvesting in taxable accounts;
- RMDs from age 73;
- a Roth / traditional mix to talk over with a tax professional.

**The audit report:** a print stylesheet, so the browser's Print → Save as PDF gives a dated
yearly audit. No PDF library is needed.

Every page says it plainly: **educational, not financial advice. Minty isn't a CFP, CFA or
registered advisor.** The rules suggest; the arithmetic is shown; you decide.

## 3. EGG, the retirement view

A header button **EGG**, next to ABC, opens a popup like ABC and Bills. Its features, kept on
purpose to these:

1. **Trend:** the total, and each account, over time (1y / 5y / all), with contributions shown
   apart from growth. That's "what I put in" against "what it earned", the one split that matters.
2. **Forecast:** the value at your retirement age in today's dollars, as three lines (cautious,
   middle, hopeful real returns), from the current total and your contribution rate. It also
   shows what that supports at a 4% withdrawal rate, as a yearly income. It runs in the browser,
   so it costs the Worker no CPU.
3. **This year's contributions** against the IRS limit for each kind of account (401(k)/403(b)/457,
   IRA, HSA), with catch-up limits by age. The limits are in code with a source and a `CHECKED`
   date.
4. **Mix and cash:** a single bar of stocks, bonds and cash, with a cash-drag flag. Only from what
   Plaid reports; no fund analysis.

Suggested extras (each small, each optional):
- **A target:** "$X by age Y", with "on track / behind by $Z a month". It turns the forecast into
  one answer.
- **Fees paid this year**, from investment transactions, when there are any.
- **Beneficiary reminder:** the one checklist item that belongs here.

Deliberately left out: daily performance, individual stock charts, rebalancing advice, and
anything that moves money.

**Islanding:** accounts of a retirement subtype (401k, 403b, 457b, IRA, Roth, SEP, SIMPLE, and
HSA if you choose; §6) are kept out of the dashboard by default:
- out of the feed, the account filter, the person totals and the audit's spending;
- their contributions count as **saving** in CFA.

Each account has a "Show on the dashboard too" switch. Brokerage (taxable) accounts aren't
retirement accounts, so they stay on the dashboard unless you move them.

## 4. How it fits Minty's rules

- **Plaid Investments.** It needs checking first (R0) that the Trial plan includes it, and which
  of Schwab, Fidelity, Betterment and Vanguard (and your 401(k)'s recordkeeper) Plaid supports.
  - **New flow:** retirement accounts are linked through a separate "Link a retirement account"
    flow that asks for `investments` (most brokerages don't offer `transactions`).
  - **Each brokerage login uses a Trial slot for good**, like any bank. That counts against the
    10, so it's worth linking only the ones you'll keep.
  - **A bank you already have** gets Investments added through update-mode Link
    (`additional_consented_products`), the way statement details work, which uses no slot.
- **Never on a request.** Holdings and investment activity are fetched by the quiet catch-up cron
  run, one bank per run, like statement details. Results go to `investment_sync`, and a failure
  there never touches `items.status` or the transaction sync. Investments-only banks are skipped
  by the transaction sync, and get their health verdict from `investment_sync` (with `MEANING`
  entries).
- **CPU (10 ms).**
  - Plaid's holdings response is stored as text and unpacked by SQLite, the same as sync pages.
  - The audit's monthly totals are computed in SQL.
  - The forecast and the charts run in the browser.
- **D1 reads.**
  - A `monthly_totals` table (month × person × bucket × category), refreshed for the months each
    sync touched, makes opening the audit read hundreds of rows instead of every transaction.
  - Balance snapshots: one row per account per day, read by an index on (account, date), thinned
    to weekly after a year.
  - Every new route gets a line in `test/reads.test.ts`, and `/audit` goes in `isHeavyRead`.
- **Charts.** A small `public/charts.js` of our own (line, stacked bar, a single bar) drawing SVG
  with the dashboard's colour tokens: light and dark, and no CDN. That's simpler than vendoring a
  library, and the CSP stays `'self'`.
- **People.** Both views follow the person switch. `owner` stays separate from `plaid_account`.
- **Migrations only add:**
  - `items.products`;
  - `accounts.view` (null means the default for the account's type);
  - `balance_snapshots`, `holdings`, `securities`, `investment_txns`, `investment_sync`;
  - `monthly_totals`, `bucket_overrides`, `audit_checklist`;
  - a per-person profile (age or birth year, retirement age, employer match, target) in
    `app_state`.
- **Demo.** Made-up retirement accounts, holdings and a year of balance history, so the demo shows
  both views.
- **Ask Minty** ([agent-plan.md](agent-plan.md)) can later explain findings ("why is dining up?")
  using the same totals. CFA doesn't wait for it.

## 5. Phases (each ends with a PR you review)

| Phase | What | Needs Plaid changes |
| --- | --- | --- |
| **R0** | Check that Investments is on the Trial plan, and the brokerages you use; your decisions (§6) | Check only |
| **C1** | Foundations: classification and transfer pairs, `monthly_totals`, daily balance snapshots, `charts.js` | No |
| **C2** | `/audit` charts: cash flow, savings rate, categories, recurring charges, debt, net worth (from day one of snapshots) | No |
| **E1** | EGG data: the retirement Link flow, the investments cron fetch, holdings and activity, islanding | Yes (Investments) |
| **E2** | The EGG view: trend, forecast, contributions against limits, mix and cash; the target | No |
| **C3** | Recommendations and the checklist, the yearly print report, and EGG's numbers in the audit | No |

C1–C2 ship value with no new Plaid product and no slots, so they come first. Balance history
also starts with C1, and every later trend needs it.

### 5.1 R0: what Plaid offers (checked 2026-10-16)

- **Investments is on the Trial plan.** Plaid's billing docs list "Investments (including
  Investments Refresh)" with Liabilities and Transactions among the Trial plan's products. It's a
  subscription product: free on Trial, but charged per bank after an upgrade to a paid plan.
- **Schwab** (first, decision 5): access is automatic, but can take up to 5 business days. Plaid
  allows one active Schwab login per person per app, so linking Schwab again with the same login
  cancels the earlier connection. Reconnect it in update mode instead.
- **Fidelity:** must be requested by hand (the Plaid dashboard's OAuth institutions page).
  **Vanguard and Betterment:** not confirmed from Plaid's own pages. Try them in Link before
  counting on them.
- Investment transactions go back up to 24 months.
- Sources: https://plaid.com/docs/account/billing/ and https://plaid.com/docs/investments/

### 5.2 C1: built

- **Migration `0013_audit.sql`:** `balance_snapshots`, `monthly_totals`, `bucket_overrides`, and
  `idx_txn_pair` on transactions.
- **`src/audit/totals.ts`,** run by the hourly cron after sync:
  - **The buckets** (§2.2), in SQL. A transfer pair also needs one side to be a Plaid transfer or
    loan payment, so a $100 purchase and an unrelated $100 deposit in the same week stay what
    they are. An unpaired TRANSFER_OUT counts as spending until a correction says otherwise (for
    example "BETTERMENT" → saving).
  - **Monthly totals,** refreshed from the month of the earliest new transaction (3 days earlier,
    for a transfer's other side). Nothing new means nothing is done. They're rebuilt whole once a
    week, or after a correction, which also catches edits and removals.
  - **A balance snapshot** per account per day, written only when the balance changed. After a
    year, one a week (Sundays) is kept.
- **D1 cost, measured:**
  - A full rebuild reads about 3 rows per transaction (about 21,000 for 7,000), once a week.
    Joining accounts would read an account row for every transaction, so the Worker reads the few
    accounts once and passes their types into the query as JSON.
  - A run with nothing new reads under 10 rows.
  - The new index adds one index row written per transaction synced.
- **Moved to C2:** `charts.js`, so it's built where it's first used and can be checked on screen.

### 5.3 C2: built

- **A popup, not a page.** CFA opens from the ⋯ menu (and `/?audit`) in ABC's frame, like Bills and
  BAM, so the live demo, the device lock, the CSP and the installed app need nothing new; 980px is
  room enough for the charts.
- **The pieces:**
  - `public/cfa.js` and `cfa.css`;
  - `public/charts.js`: grouped bars, lines and a legend in SVG, drawn at the container's pixel
    width so the text stays its size on a phone;
  - `src/routes/audit.ts`: `GET /audit` and `PUT /audit/buckets`;
  - migration `0014_audit_views.sql`: `net_worth` and `recurring_charges`.
- **Its sections**, each with plain-words findings:
  - **Cash flow**, with the savings rate (money in, less spending and loan payments) against the
    15–20% planners suggest, and its trend by month.
  - **Spending by category**: each one's last 3 months against its own average, flagged when up
    20% and $50 a month (after 6 full months).
  - **Recurring charges**: weekly, monthly, quarterly and yearly, with the price rises and the ones
    that may have ended. Rent and utilities are counted apart from subscriptions, and each charge
    has a "counts as" correction.
  - **Fees, interest and debt**, with the card balances.
  - **Net worth** by day.
  - **The household's corrections.**
- **Where the history starts:** the first month with at least half the usual number of
  transactions (and at least 5). Otherwise an account linked with a longer history (a card's
  annual fee from last January) dilutes every average.
- **Statement credits** (money back under BANK_FEES) are their own category, CREDITS, so fees stay
  the real fees. `RULES_VERSION` makes a rules change rebuild every month at the next run.
- **Corrections** apply at the next quiet 10-minute run (the dashboard says so), not on the
  request.
- **Recurring charges** are found with the weekly rebuild (about 8 rows read per transaction over
  a year of spending), so a new subscription shows within a week.
- **Net worth** is written with the day's balance snapshot. It counts the bank, investment, card
  and loan accounts Minty sees, nothing else.
- **`/audit` reads only the prepared tables:** under 3,000 rows in `test/reads.test.ts`, whatever
  the history.

### 5.4 E1: built (retirement accounts from Plaid Investments)

- **Two ways in** (connect page):
  - **Link a retirement account:** a new login, with Link asking for `investments` only. It
    reserves a Trial slot like any bank (Link sessions, `chooseAccountFor`'s order) and is stored
    with `items.products = 'investments'`.
  - **Investment accounts → Add:** Investments added to a bank already linked, through update-mode
    Link (`additional_consented_products`), turned on only after `/item/get` lists the consent,
    like statement details. It uses no slot. This is the way for Schwab when it's already linked:
    Schwab allows one connection per person per app, so linking it again would end the first.
- **The fetch** (`src/investments.ts`), in a quiet 10-minute catch-up run after statement
  details, one due bank per run, refreshed daily:
  - `/investments/holdings/get` (accounts, securities and holdings, replacing what each account
    held);
  - a page of `/investments/transactions/get` (24 months the first time, then the last 30 days),
    paged across runs.
  - SQLite unpacks the text; the page's total is read with a regular expression, so the Worker
    never parses JSON.
  - `PRODUCT_NOT_READY` retries in 30 minutes. Failures go on `investment_sync` only, never on
    `items.status`.
- **Investments-only logins** are skipped by the transaction sync. Their health verdict comes from
  the fetch (fetching, consent needed, not supported, or no update for 48 hours), and the new codes
  have plain-words entries in `MEANING`.
- **Islanding:** accounts with a retirement subtype (401k, 403b, 457b, IRA, Roth, SEP, SIMPLE,
  pension, HSA and the Canadian ones) are left out of `/accounts` and `/transactions` (so an HSA's
  spending leaves the feed), unless `accounts.view` says otherwise
  (`PUT /accounts/{id}/view`). `/accounts?view=all` lists everything. Brokerage accounts stay on the
  dashboard.
- **Migration `0015_investments.sql`:** `items.products`, `accounts.view`, `investment_sync`,
  `securities`, `holdings`, `investment_txns`.
- **To check on Plaid Sandbox (the owner):** link a retirement account with a Sandbox
  institution and `user_good`, then within 10 minutes Setup checks show it fetched. Also try
  Investment accounts → Add on an existing Sandbox bank.

### 5.5 E2: built (the EGG view)

- **Where:** a header button **EGG** next to ABC and BAM (and `/?egg`), in ABC's frame with CFA's
  section and chart styles.
- **The pieces:**
  - `public/egg.js` and `egg.css`;
  - `src/routes/retirement.ts`: `GET /retirement` and `PUT /retirement/profile`;
  - `src/retirement/limits.ts`: the IRS limits as code, with sources and `CHECKED`.
- **Trend:** the retirement accounts' total by day (each account's newest snapshot carried
  forward), over 1 or 5 years or all of it. Once there's a year of history, it shows what went in
  apart from what it earned.
- **Forecast,** in today's dollars: the current total and the last 12 months' contributions,
  grown at 3, 5 and 7% real a year to the retirement age (65 without a profile).
  - The 4% withdrawal income.
  - For a target: on track, or how much more a month would reach it.
  - In the Everyone view it covers everyone, over 20 years.
- **This year's contributions** against the limits for 401(k)/403(b)/457(b), IRA, SIMPLE and HSA
  (self or family), with the catch-ups by age (50+; 60–63 for workplace plans; 55+ for an HSA)
  and an even-pace marker.
  - Behind the pace, it gives the monthly amount that reaches the limit.
  - It reminds you about the employer match.
  - Only contributions and deposits count, never a rollover or a dividend.
  - 2026 figures: IRS Notice 2025-67 and Rev. Proc. 2025-19.
- **Mix:** stocks, target-date and balanced, bonds, cash and other, sorted by fund names (Plaid's
  security types don't tell a bond fund from a stock fund, and the page says so). It flags cash
  over 10% before 55.
- **Accounts,** each with "Show on the dashboard too", and the other investment accounts, which can
  be moved in.
- **The profile** (optional, in `app_state` per person): birth year, retirement age, target, match
  %, HSA coverage, and the date beneficiaries were last checked (the beneficiary reminder).
- **Reads:** every query starts from the accounts (`CROSS JOIN`), so it reads only the retirement
  accounts' rows by index. Left to itself, SQLite walked all 8,000 transactions; it's now 1,460
  rows for 3 accounts with a year of daily balances.
- **Demo:** made-up 401(k), Roth IRA, HSA and rollover IRA, with holdings, two years of
  contributions and five months of balances.

### 5.6 C3: built (recommendations, the checklist, the printed audit)

- **What to do,** at the top of CFA: findings from `src/audit/rules.ts`, a pure function over what
  the cron prepared (`GET /audit/advice` gathers it, never reading the transactions).
  - **Order:** must-acts first, then by dollars a year.
  - **Each finding** shows why it matters, one action, and "How this was worked out" (the numbers
    and the rule's basis).
  - **Saving:** the savings rate under 15% (or good news at 20%+); an emergency fund under 3
    months of spending; cash in checking above 2 months of spending (the dollars a year assume 3%
    interest, and say so).
  - **Debt and fees:** card interest (its own category now, `INTEREST`, with `RULES_VERSION` 3),
    and fees.
  - **Spending:** a category up 20% and $50 a month; a fixed price that rose; 3+ subscriptions
    worth $300+ a year.
  - **Retirement:** behind this year's pace for a limit; collect the employer match; no retirement
    accounts linked; cash over 10% before 55.
  - **Investing:** a single stock over 10% of investments, never a fund.
- **Where the history starts,** for both the charts and the rules: the first month with 40% of the
  busiest month's transactions (and 5). With the median instead, a long quiet tail of card credits
  before the bank's history started made every category look "up 100–200%".
- **The planner's checklist:** beneficiaries, a will, term life, disability, umbrella, a credit
  freeze (FTC link), the Social Security record (ssa.gov link), deductibles, tax-loss harvesting
  (with taxable investments), traditional or Roth, and RMDs (near 73).
  - Each is ticked household-wide (`PUT /audit/checklist`, in `app_state`), and comes back a year
    later.
  - EGG's beneficiary tick counts too.
- **Print the audit:** a print stylesheet keeps only the audit, light whatever the theme, with the
  date at the top and without the controls. Print → Save as PDF gives the yearly report.

### 5.7 The IRS limits, fetched once a year (owner, 2026-10-16)

- **Two IRS pages, each at a stable address.** The yearly press release's address changes, so it
  isn't one of them.
  - **The COLA table:** 401(k)/403(b)/457(b) deferrals and catch-up, IRA, SIMPLE, and the 60–63
    catch-up in its footnote. It has a column per year.
  - **Publication 969:** HSA limits ("For 2026, if you have self-only HDHP coverage, you can
    contribute up to $4,400 …") and the 55+ catch-up.
- **When:** from a quiet catch-up cron run, never on a request.
  - Each page is asked only while a year it should have isn't settled: this year, and from
    November next year (the COLA table; the HSA figures come with the new year's Publication 969).
    Retries are at most once a week.
  - Once settled, a page isn't asked again for that year, so it's one request a year when the IRS
    has published.
- **Checked before it's kept:** whole dollars in $50 steps, within 0.9× to 1.5× the last known
  value (the code's, or an earlier year fetched). A page that changed shape gives nothing, never a
  wrong number.
- **Fallbacks:** the code's values (`src/retirement/limits.ts`). For a figure not published yet for
  this year, last year's, listed as `provisional` (EGG says so).
- **CPU:** only the tables' stretch of each page is turned into text (the pages are ~100 KB and
  ~300 KB).
- **`IRS_LIMITS=off`** never asks irs.gov. Tests run with it off, and test the parsers on parts of
  the real pages.

## 6. Decisions (owner, 2026-10-16)

Made: **CFA** keeps its name (Complete financial audit); the retirement button is **EGG**; an
**HSA counts as a retirement account** (islanded, switchable); the **profile** is stored, every
field optional; **Schwab** first.

The questions as they were asked:

1. **The name "CFA".** "CFA" is a registered mark of CFA Institute, for a professional
   credential, so a button labelled CFA could read as credentialed advice.
   - For a private noncommercial tool the risk is small. But Minty is public, and forks show it to
     their households.
   - Options: keep "CFA (Complete financial audit)" with the disclaimer, or a neutral three
     letters like **AUD** (audit) or **FAR** (financial audit report).
   - My suggestion: name the page "Complete financial audit" and the button **AUD**.
2. **The retirement button: EGG** (nest egg) is my suggestion. Alternatives are RET and NST.
   Avoid RIA (that's a registered investment adviser).
3. **Is an HSA a retirement account?** It's often used as one. The suggestion is islanded but
   switchable.
4. **The profile:** age or birth year, retirement age, employer match % and an optional target,
   kept in D1. All optional; without them the forecast uses your observed contributions and age 65.
5. **Which brokerages first**, for the R0 check.
