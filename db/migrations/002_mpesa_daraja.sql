-- ==================================================================
--   RetailFlow — Migration 002: M-Pesa Daraja Integration
--   --------------------------------------------------------------
--   Adds multi-tenant M-Pesa configuration storage (credentials are
--   stored AES-256-GCM encrypted — NEVER in plain text) and a ledger
--   of M-Pesa STK Push transactions.
--
--   Apply on an already-deployed database:
--     npx wrangler d1 execute retailflow-pos-dev --remote --file=db/migrations/002_mpesa_daraja.sql
--   (fresh installs get these tables from db/schema.sql directly)
--
--   Before going live, set the master encryption key as a Worker
--   secret (this key is NEVER stored in D1 or exposed to the
--   browser):
--     npx wrangler secret put RETAILFLOW_ENCRYPTION_KEY
-- ==================================================================

-- ---- M-Pesa configurations (one per business) ----
CREATE TABLE IF NOT EXISTS mpesa_configurations (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 0,
    environment TEXT DEFAULT 'sandbox',
    shortcode TEXT NOT NULL,
    shortcode_type TEXT DEFAULT 'Till',
    consumer_key_encrypted TEXT NOT NULL,
    consumer_secret_encrypted TEXT NOT NULL,
    passkey_encrypted TEXT NOT NULL,
    callback_url TEXT,
    account_reference TEXT,
    transaction_desc TEXT,
    last_connection_test TEXT,
    connection_status TEXT DEFAULT 'Not Tested',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mpesa_config_business
ON mpesa_configurations(business_id);

CREATE INDEX IF NOT EXISTS idx_mpesa_config_enabled
ON mpesa_configurations(enabled);

CREATE INDEX IF NOT EXISTS idx_mpesa_config_status
ON mpesa_configurations(connection_status);

-- ---- M-Pesa STK Push transactions ledger ----
CREATE TABLE IF NOT EXISTS mpesa_transactions (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    sale_id TEXT,
    merchant_request_id TEXT,
    checkout_request_id TEXT,
    phone_number TEXT NOT NULL,
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
    FOREIGN KEY (business_id)
        REFERENCES businesses(id)
        ON DELETE CASCADE,
    FOREIGN KEY (branch_id)
        REFERENCES branches(id)
        ON DELETE SET NULL,
    FOREIGN KEY (sale_id)
        REFERENCES sales(id)
        ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_business
ON mpesa_transactions(business_id);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_branch
ON mpesa_transactions(branch_id);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_sale
ON mpesa_transactions(sale_id);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_checkout
ON mpesa_transactions(checkout_request_id);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_merchant
ON mpesa_transactions(merchant_request_id);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_receipt
ON mpesa_transactions(mpesa_receipt_number);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_status
ON mpesa_transactions(status);

CREATE INDEX IF NOT EXISTS idx_mpesa_transactions_created
ON mpesa_transactions(created_at);