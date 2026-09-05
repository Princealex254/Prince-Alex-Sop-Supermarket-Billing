-- ==================================================================
--   RetailFlow — Migration 003: M-Pesa Direct Till Support
--   --------------------------------------------------------------
--   Makes phone_number nullable in mpesa_transactions to support
--   Direct Till payments where no phone number is involved.
--
--   Apply on an already-deployed database:
--     npx wrangler d1 execute retailflow-pos-dev --remote --file=db/migrations/003_mpesa_direct_till.sql
-- ==================================================================

-- D1 (SQLite) does not support ALTER COLUMN, so we recreate the table.
-- Preserve existing rows, defaulting phone_number to empty string for
-- any legacy rows that somehow have NULL.

CREATE TABLE IF NOT EXISTS mpesa_transactions_new (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    sale_id TEXT,
    merchant_request_id TEXT,
    checkout_request_id TEXT,
    phone_number TEXT,
    amount REAL NOT NULL,
    account_reference TEXT,
    transaction_desc TEXT,
    mpesa_receipt_number TEXT,
    transaction_date TEXT,
    status TEXT DEFAULT 'Pending',
    result_code INTEGER,
    result_description TEXT,
    raw_callback TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

INSERT INTO mpesa_transactions_new
SELECT * FROM mpesa_transactions;

DROP TABLE mpesa_transactions;

ALTER TABLE mpesa_transactions_new RENAME TO mpesa_transactions;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_business ON mpesa_transactions(business_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_branch ON mpesa_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_sale ON mpesa_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_checkout ON mpesa_transactions(checkout_request_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_merchant ON mpesa_transactions(merchant_request_id);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_receipt ON mpesa_transactions(mpesa_receipt_number);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status ON mpesa_transactions(status);
CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_created ON mpesa_transactions(created_at);
