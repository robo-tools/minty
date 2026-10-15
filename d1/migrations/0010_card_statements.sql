-- Liabilities is opt-in per existing Item. Its failures never change transaction sync state.
ALTER TABLE link_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reconnect';

CREATE TABLE liability_sync (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    enabled_at TEXT NOT NULL,
    attempted_at TEXT,
    synced_at TEXT,
    next_attempt_at TEXT,
    last_error TEXT
);
CREATE INDEX idx_liability_due ON liability_sync(next_attempt_at);

CREATE TABLE card_liabilities (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    plaid_account_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mask TEXT,
    currency TEXT,
    current_balance_cents INTEGER,
    statement_balance_cents INTEGER,
    statement_issue_date TEXT,
    minimum_payment_cents INTEGER,
    payment_due_date TEXT,
    last_payment_cents INTEGER,
    last_payment_date TEXT,
    purchase_apr REAL,
    is_overdue INTEGER,
    available INTEGER NOT NULL DEFAULT 1,
    observed_at TEXT NOT NULL,
    UNIQUE(item_id, plaid_account_id)
);

-- One entry per observed statement, updated if the issuer corrects it. Unknown current
-- values don't erase a previously observed historical value. This is not a payment ledger.
CREATE TABLE card_statements (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES card_liabilities(id) ON DELETE CASCADE,
    issue_date TEXT NOT NULL,
    balance_cents INTEGER,
    minimum_payment_cents INTEGER,
    payment_due_date TEXT,
    currency TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(account_id, issue_date)
);
CREATE INDEX idx_card_statement_history ON card_statements(account_id, issue_date DESC);

CREATE TABLE manual_bills (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    currency TEXT NOT NULL,
    due_date TEXT NOT NULL,
    recurrence TEXT NOT NULL CHECK(recurrence IN ('once', 'monthly')),
    anchor_day INTEGER NOT NULL,
    paid_at TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE manual_bill_payments (
    id INTEGER PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES manual_bills(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    marked_at TEXT NOT NULL,
    UNIQUE(bill_id, due_date)
);
