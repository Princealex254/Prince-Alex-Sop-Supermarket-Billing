-- ==================================================================
--   RetailFlow — Migration 004: Product Offers
--   --------------------------------------------------------------
--   Adds offer_price column to products for special pricing/promotions.
--   When offer_price is set and > 0, it overrides selling_price.
--
--   Apply on an already-deployed database:
--     npx wrangler d1 execute retailflow-pos-dev --remote --file=db/migrations/004_product_offers.sql
-- ==================================================================

ALTER TABLE products ADD COLUMN offer_price REAL DEFAULT 0;
