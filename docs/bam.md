# BAM (Balance of Award Miles & points)

**Status: M1 and M2 built (2026-10-16), with M3's first two extras.**
- **M1:** the view, typing balances in, and history.
- **M2:** statement PDFs, Amex Membership Rewards first.
- **M3's first two:** expiry rules, and the cards that likely earn each currency.
- **Next:** more programs' statement layouts, when there are PDFs to model them on. Decisions: §5.

**Built:**
- `public/bam.js` and `bam.css`: the BAM button next to ABC, and its popup.
- `public/pdf-read.js`: the PDF reader and the folder, shared with Bills.
- `public/points-parse.js`: reads a balance from a statement.
- `src/routes/points.ts`: `GET`, `POST`, `PUT` and `DELETE /points`, and `POST /points/known`.
- `src/points/programs.ts`: the programs, their expiry rules and "earned by" rules.
- Migration `0012_point_balances.sql`. It has no index: `GET /points` reads each reading once. D1
  counts an `ORDER BY` as a second read, so the Worker groups and sorts the rows instead.

**How M2 reads statements:**
- **The four layouts:** pdf.js gives text in the order it was drawn, so the Amex box's number can
  come after its "as of" date, before it, or even before the box's title (a right-aligned number
  is often drawn first). The parser accepts all of them. It never takes a dollar amount, a date,
  a phone number or a percentage, and the box with the date wins over other mentions (promotions,
  "points earned").
- **The card's last 4:** taken from "Account Ending 7-12004" (giving `2004`).
- **Joining a balance:** a statement whose last 4 matches no balance joins the person's only
  balance in that program that has no last 4. Without this, a typed-in balance and the statement
  would show as two.
- **The shared folder:** each view checks it with its own "already added" list and its own
  skipped list.
  - BAM sets aside PDFs with no balance in them, such as bills.
  - Bills sets aside card statements (a PDF with a points box), because it shows those from the
    bank.
  - Picked by hand, either kind is shown unticked, saying why.

Your own award wallet: every miles and points balance in the household, in one view, grouped by
currency (Chase Ultimate Rewards, Amex Membership Rewards, United, Hyatt, …). Each balance
shows when it was last updated. Balances come from statement PDFs read on your device (exactly
like Bills) or are typed in by hand.

BAM never signs in to a loyalty program, never stores a loyalty login, and never scrapes a
website. Plaid doesn't report points, so the PDFs and your own numbers are the only sources. That
is on purpose: it avoids the credentials and the terms-of-service problems that scraping wallets
have.

## 1. The view

A header button **BAM**, next to ABC (and EGG later), opens a popup like ABC and Bills.

- **One row per balance:**
  - the currency and its kind (bank points, airline, hotel);
  - the person, with the account's last 4 digits when there's more than one;
  - **the number of miles or points**;
  - **last updated**, as a date with "3 days ago". Balances not updated in 90 days are greyed,
    with "update?".
- **Grouped by kind** (bank and card points, airlines, hotels, then programs typed in), then by
  currency. A currency a linked card likely earns shows even with no balance yet ("No balance yet.
  Add it"). Each currency shows a total across the household when it has more than one balance,
  because points in the same program can often be combined. Each balance names its person, as ABC
  does.
- **Update a balance:**
  - **Update** saves a new reading, with today's date.
  - **Fix this one** corrects a reading.
  - **Delete** removes a reading; the one before it shows again.
  - M2 adds **Add from PDFs** and **Add a folder**, like Bills.
- **History:** each reading is kept. A balance shows its change since the reading before, and
  **History (n)** lists the earlier readings with their changes: a small trend for free, with no
  extra fetching. A reading dated before the newest one (from an old statement) goes into the
  history, not on top.

## 2. Reading statements (the Bills way, shared)

- **The same flow as Bills:** pick PDFs or a folder (remembered on Chrome and Edge). Each PDF is
  fingerprinted (SHA-256) and checked against the ones already added. Only new ones are read with
  pdf.js, on the device. A review table shows what was found, editable, before anything is saved.
  **The PDFs never leave the device**: only the program, balance, date, last 4 digits and the
  fingerprint are saved.
- **Shared code:** the PDF part of `public/bills.js` (fingerprint, pdf.js text, folder, the
  "already added" check, the skipped list) moves to `public/pdf-read.js`, used by both. Bills
  doesn't change for the user.
- **`public/points-parse.js`** works like `bill-parse.js`: a pure function, with its patterns in
  code and tests from made-up text. It reads:
  - **card statements** that print the rewards balance (the issuer's points currency, its
    balance, the statement date, the last 4 digits);
  - **loyalty programs' own statements** (an airline's or hotel's monthly email or PDF, saved as
    a PDF): the program, the balance, the "as of" date, the member number's last 4.
- A statement often carries both a bill and a points balance. With one remembered folder for
  both, each PDF can feed both views (§5).

## 3. Data and routes

- **The program catalog in code** (`src/points/programs.ts`): each currency's name, kind, unit
  (points or miles) and the patterns that recognise it, with a source and a `CHECKED` date, like
  ABC's catalog. Never fetched at runtime.
- **One table, added by a migration:** `point_balances (id, owner, program, account_hint,
  balance, as_of, source manual|pdf, file_sha256 UNIQUE, created_at)`.
  - Each row is one reading. The view shows the newest reading per (owner, program,
    account_hint).
  - Index on (owner, program, account_hint, as_of).
  - A program the catalog doesn't know can still be typed in by name (`program` is free text,
    capped at 40).
- **Routes:**
  - `GET /points`;
  - `POST /points` (a reading, by hand or from a PDF);
  - `PUT` and `DELETE /points/{id}`;
  - `POST /points/known` (which fingerprints are already added).
  - They're added to `run_worker_first`, with lines in `test/reads.test.ts` (tiny: one row per
    reading).
  - No Plaid, no cron, no new secret.
- **Demo:** made-up balances across a few currencies, so the demo shows BAM.

## 4. Phases

| Phase | What |
| --- | --- |
| **M1** | The view and typing balances in: catalog, table, routes, the BAM popup, history, "update?" |
| **M2** | PDFs: `pdf-read.js` shared with Bills, `points-parse.js` for card statements and the first loyalty programs, the review table |
| **M3** | Optional extras from §5, if wanted |

M1 is small and useful alone. M2 depends on real statement layouts: parser tests use made-up
text modelled on them, never a real statement.

**Possible extras (less is more, so each is optional):**
- **Which card earns into which currency:** ABC already knows the household's cards. BAM can list
  under each currency the cards that earn it.
- **Expiry reminder:** for programs whose points expire after inactivity, from a rule in the
  catalog (with source and `CHECKED`). Shown only when BAM knows the last activity date.
- **An estimated value** in dollars per currency, at a rate you set (values are opinions, so none
  are built in). Off by default.

## 5. Decisions (owner, 2026-10-16)

1. **The name is BAM** (Balance of Award Miles & points), not MAP.
2. **One folder, shared with Bills,** with each PDF offered to both views (§2).
3. **Amex Membership Rewards first** for M2's patterns. The statement's box reads:
   `Membership Rewards® Points` / `Available and Pending as of 08/31/26` / `65,536`. The card is
   in the header as `Account Ending 8-43005`, which gives a last 4 of `3005`. Tests use made-up text
   in this layout, never a real statement.
4. **The first two M3 extras:**
   - **Which cards earn each currency:** from ABC's card list, with an "earns" field per card.
   - **Expiry reminders:** a rule per program, with a source and `CHECKED`. For Membership Rewards
     that's "doesn't expire while a card that earns it is open", shown as a quiet note.
   - Not now: the dollar values.
