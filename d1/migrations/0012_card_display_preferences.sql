-- Display-only preferences follow the stable bank account across transaction/statement
-- syncs. Keep issuer names, reported masks, balances, and sync cursors untouched.
CREATE TABLE card_display_preferences (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    plaid_account_id TEXT NOT NULL,
    nickname TEXT CHECK(nickname IS NULL OR length(nickname) BETWEEN 1 AND 80),
    display_mask TEXT CHECK(display_mask IS NULL OR
        (length(display_mask) IN (4, 5) AND display_mask NOT GLOB '*[^0-9]*')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(item_id, plaid_account_id)
);
