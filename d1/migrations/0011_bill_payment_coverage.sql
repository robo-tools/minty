-- Add the source fields needed for payment estimates. Existing cursors and transactions
-- are preserved; legacy Items start with unknown history coverage until a successful sync.
ALTER TABLE accounts ADD COLUMN credit_limit_cents INTEGER;
ALTER TABLE card_liabilities ADD COLUMN credit_limit_cents INTEGER;
ALTER TABLE transactions ADD COLUMN category_detailed TEXT;
ALTER TABLE transactions ADD COLUMN category_confidence TEXT;

ALTER TABLE items ADD COLUMN transactions_update_status TEXT;
ALTER TABLE items ADD COLUMN transactions_history_requested_start_date TEXT;
ALTER TABLE items ADD COLUMN transactions_history_start_date TEXT;

-- The requested boundary is recorded only for newly linked Items whose request we know.
-- A historical-complete sync establishes coverage from that boundary, or from the date
-- completeness is first observed for a legacy Item. Never infer coverage from its oldest
-- transaction: an empty or sparse feed cannot prove that an earlier period was downloaded.
