-- ==================================================================
--   RetailFlow — Migration 005: Settings Toggles
--   --------------------------------------------------------------
--   Adds the missing settings columns that the admin panel saves
--   (receiptPaperless, barcodeScanner, customerDisplay, staffReports,
--    staffRefunds, lowStockAlerts, multiBranch) but were never
--   present in the settings table.
--
--   Apply on an already-deployed database:
--     npx wrangler d1 execute retailflow-pos-dev --remote --file=db/migrations/005_settings_toggles.sql
-- ==================================================================

ALTER TABLE settings ADD COLUMN receipt_paperless INTEGER DEFAULT 1;
ALTER TABLE settings ADD COLUMN barcode_scanner INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN customer_display INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN staff_reports INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN staff_refunds INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN low_stock_alerts INTEGER DEFAULT 0;
ALTER TABLE settings ADD COLUMN multi_branch INTEGER DEFAULT 0;