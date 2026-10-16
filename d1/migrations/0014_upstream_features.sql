-- Import independent upstream features while preserving the applied Bills schema.
-- Source: rg-code/minty 72bfcd99e80320001f9eecd227926c7cd6ab0def.

-- Imported from 0012_point_balances.sql
-- BAM (docs/bam.md): miles and points balances, typed in or (M2) read from a statement PDF in the
-- browser. Each row is one reading of one balance; the view shows the newest per person, program
-- and account. Only the fields are stored, never the PDF; its SHA-256 lets the same file be
-- skipped next time.
CREATE TABLE point_balances (
    id           INTEGER PRIMARY KEY,
    owner        TEXT    NOT NULL,                     -- MINTY_USERS key
    program      TEXT    NOT NULL,                     -- an id from src/points/programs.ts, or a name typed in
    account_hint TEXT,                                 -- the account's or member number's last 4 digits, if several
    balance      INTEGER NOT NULL CHECK (balance >= 0),
    as_of        TEXT    NOT NULL,                     -- YYYY-MM-DD: the date the balance was correct
    source       TEXT    NOT NULL CHECK (source IN ('manual', 'pdf')),
    file_sha256  TEXT    UNIQUE,                       -- the PDF's fingerprint (pdf only)
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- No index: a household has a few hundred readings, and GET /points reads them all once (an index
-- walk plus row lookups would read each twice).

-- Imported from 0013_audit.sql
-- CFA, the Complete financial audit (docs/cfa.md), phase C1: the data the audit's charts read.
--   balance_snapshots: each account's balance once a day (the hourly cron writes it only when it
--     changed), so trends and net worth have a history. Older than a year, only Sundays are kept.
--   monthly_totals: transactions summed per month, person, bucket (income, spend, saving,
--     transfer, debt) and Plaid category, kept by the hourly cron, so opening the audit reads
--     hundreds of rows instead of every transaction. Plaid's sign: positive = money out.
--   bucket_overrides: a household's correction of a merchant's bucket ("BETTERMENT" is saving).
--     Sync never writes it, like tags.
--   idx_txn_pair: finds a transfer's other side (the same amount the other way, within 3 days, one
--     side a Plaid transfer) from the index alone.
CREATE TABLE balance_snapshots (
    account_id      INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    date            TEXT    NOT NULL,                  -- YYYY-MM-DD (UTC)
    current_cents   INTEGER,
    available_cents INTEGER,
    PRIMARY KEY (account_id, date)
) WITHOUT ROWID;

CREATE TABLE monthly_totals (
    month        TEXT    NOT NULL,                     -- YYYY-MM
    owner        TEXT    NOT NULL,                     -- MINTY_USERS key
    bucket       TEXT    NOT NULL CHECK (bucket IN ('income', 'spend', 'saving', 'transfer', 'debt')),
    category     TEXT    NOT NULL,                     -- Plaid's primary category, or 'OTHER'
    amount_cents INTEGER NOT NULL,
    n            INTEGER NOT NULL,
    PRIMARY KEY (month, owner, bucket, category)
) WITHOUT ROWID;

CREATE TABLE bucket_overrides (
    merchant   TEXT PRIMARY KEY,                       -- upper(merchant_name, else name)
    bucket     TEXT NOT NULL CHECK (bucket IN ('income', 'spend', 'saving', 'transfer', 'debt')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_txn_pair ON transactions (amount_cents, date, account_id, pending, category);

-- Imported from 0014_audit_views.sql
-- CFA (docs/cfa.md), phase C2: what the audit's net worth and recurring charges read, kept by the
-- hourly cron (src/audit/totals.ts), never on a request.
--   net_worth: per day and person, what the accounts hold (bank and investment balances) and owe
--     (cards and loans), written with the day's balance snapshot, only when it changed.
--   recurring_charges: payments that repeat (same merchant, a weekly, monthly, quarterly or yearly
--     rhythm, similar amounts), found in the last 400 days of spending. Rebuilt daily.
CREATE TABLE net_worth (
    date         TEXT    NOT NULL,                     -- YYYY-MM-DD (UTC)
    owner        TEXT    NOT NULL,
    assets_cents INTEGER NOT NULL,
    debts_cents  INTEGER NOT NULL,                     -- what's owed, positive
    PRIMARY KEY (date, owner)
) WITHOUT ROWID;

CREATE TABLE recurring_charges (
    owner           TEXT    NOT NULL,
    merchant        TEXT    NOT NULL,                  -- upper(merchant_name, else name), as bucket_overrides
    name            TEXT,                              -- as the newest charge shows it
    category        TEXT,
    cadence         TEXT    NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'quarterly', 'yearly')),
    n               INTEGER NOT NULL,                  -- charges seen
    avg_cents       INTEGER NOT NULL,
    last_cents      INTEGER NOT NULL,
    prev_cents      INTEGER,                           -- the charge before the newest
    distinct_amounts INTEGER NOT NULL,                 -- few means a fixed price (a rise is worth flagging)
    first_date      TEXT    NOT NULL,
    last_date       TEXT    NOT NULL,
    PRIMARY KEY (owner, merchant)
) WITHOUT ROWID;

-- Imported from 0015_investments.sql
-- EGG, the retirement view (docs/cfa.md §3), phase E1: investment accounts from Plaid Investments.
--   items.products: 'transactions' (every bank so far) or 'investments' (a retirement or brokerage
--     login linked for Investments only: the transaction sync skips it).
--   accounts.view: where an account shows. NULL = by its type (retirement accounts, HSAs included,
--     go to EGG; everything else to the dashboard); 'dashboard' or 'retirement' = the household's choice.
--   investment_sync: per bank with Investments on, like statement_sync: pending, ready,
--     consent_required, unsupported or error, fetched by the quiet catch-up cron (src/investments.ts).
--     txn_start / txn_offset page through investment transactions across runs.
--   securities, holdings: what each investment account holds (replaced on each fetch).
--   investment_txns: buys, sells, contributions, dividends and fees, up to 24 months back.
ALTER TABLE items ADD COLUMN products TEXT NOT NULL DEFAULT 'transactions';
ALTER TABLE accounts ADD COLUMN view TEXT CHECK (view IN ('dashboard', 'retirement'));

CREATE TABLE investment_sync (
    item_id         INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    status          TEXT    NOT NULL CHECK (status IN ('pending', 'ready', 'consent_required', 'unsupported', 'error')),
    enabled_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    synced_at       TEXT,
    attempted_at    TEXT,
    next_attempt_at TEXT,
    last_error      TEXT,                              -- a Plaid error code, never data
    txn_start       TEXT,                              -- the window being paged through (YYYY-MM-DD)
    txn_offset      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE securities (
    security_id        TEXT PRIMARY KEY,               -- Plaid's, the same across banks
    name               TEXT,
    ticker             TEXT,
    type               TEXT,                           -- equity, etf, mutual fund, fixed income, cash, derivative, other
    is_cash_equivalent INTEGER,
    close_price        REAL,
    close_price_as_of  TEXT,
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE holdings (
    account_id       INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    security_id      TEXT    NOT NULL,
    quantity         REAL,
    value_cents      INTEGER,                          -- the institution's value
    cost_basis_cents INTEGER,
    price            REAL,
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (account_id, security_id)
) WITHOUT ROWID;

CREATE TABLE investment_txns (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    plaid_inv_txn_id  TEXT    NOT NULL UNIQUE,
    date              TEXT    NOT NULL,
    name              TEXT,
    type              TEXT,                            -- buy, sell, cancel, cash, fee, transfer
    subtype           TEXT,                            -- contribution, dividend, management fee, ...
    amount_cents      INTEGER,                         -- Plaid's sign: positive = cash out of the account
    quantity          REAL,
    fees_cents        INTEGER,
    security_id       TEXT
);
CREATE INDEX idx_inv_txns_account_date ON investment_txns (account_id, date);
