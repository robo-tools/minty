-- Explicitly reconcile a legacy Item's stored transactions with Plaid's available date range.
-- No cursor, transaction, or requested-history boundary is changed by this migration.
ALTER TABLE items ADD COLUMN transactions_verified_start_date TEXT;
ALTER TABLE items ADD COLUMN transactions_verified_end_date TEXT;
ALTER TABLE items ADD COLUMN transactions_verified_at TEXT;

CREATE TABLE history_verifications (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    captured_cursor TEXT NOT NULL,
    captured_updated_at TEXT NOT NULL,
    captured_accounts TEXT NOT NULL,
    source_updated_at TEXT,
    total_count INTEGER,
    checked_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    lease_token TEXT,
    lease_expires_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','complete','failed')),
    failure_code TEXT,
    completed_at TEXT
);

-- IDs only: access tokens and source transaction payloads never live in durable verification state.
CREATE TABLE history_verification_seen (
    item_id INTEGER NOT NULL REFERENCES history_verifications(item_id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    plaid_txn_id TEXT NOT NULL,
    PRIMARY KEY(item_id, run_id, plaid_txn_id)
);

-- Used and deleted inside one D1 batch; a failed batch rolls the staging insert back too.
CREATE TABLE history_verification_pages (
    item_id INTEGER PRIMARY KEY REFERENCES history_verifications(item_id) ON DELETE CASCADE,
    body TEXT NOT NULL
);
