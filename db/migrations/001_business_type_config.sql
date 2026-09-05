-- ==================================================================
--   RetailFlow — Migration 001: Business-Type Configuration
--   --------------------------------------------------------------
--   Adds the multi-business-type configuration columns to existing
--   D1 databases and backfills type_code from the legacy type labels.
--
--   Apply on an already-deployed database:
--     npx wrangler d1 execute retailflow-pos-dev --remote --file=db/migrations/001_business_type_config.sql
--   (fresh installs get these columns from db/schema.sql directly)
-- ==================================================================

ALTER TABLE businesses ADD COLUMN type_code TEXT;
ALTER TABLE businesses ADD COLUMN enabled_modules TEXT;
ALTER TABLE businesses ADD COLUMN business_features TEXT;

ALTER TABLE products ADD COLUMN product_type TEXT DEFAULT 'product';

CREATE INDEX IF NOT EXISTS idx_businesses_type_code ON businesses(type_code);
CREATE INDEX IF NOT EXISTS idx_products_product_type ON products(product_type);

-- ---- One-time backfill of existing rows from legacy type labels ----
UPDATE businesses SET type_code = 'retail'      WHERE type_code IS NULL AND lower(trim(type)) IN ('shop','retail','retail / shop','retail shop','general');
UPDATE businesses SET type_code = 'supermarket' WHERE type_code IS NULL AND lower(trim(type)) = 'supermarket';
UPDATE businesses SET type_code = 'restaurant'  WHERE type_code IS NULL AND lower(trim(type)) = 'restaurant';
UPDATE businesses SET type_code = 'cafe'        WHERE type_code IS NULL AND lower(trim(type)) IN ('café','cafe','cafes','café / coffee shop');
UPDATE businesses SET type_code = 'bar'         WHERE type_code IS NULL AND lower(trim(type)) IN ('bar','bar / lounge','lounge');
UPDATE businesses SET type_code = 'hotel'       WHERE type_code IS NULL AND lower(trim(type)) = 'hotel';
UPDATE businesses SET type_code = 'pharmacy'    WHERE type_code IS NULL AND lower(trim(type)) IN ('pharmacy','chemist');
UPDATE businesses SET type_code = 'clothing'    WHERE type_code IS NULL AND lower(trim(type)) IN ('clothing','fashion','boutique','fashion / clothing');
UPDATE businesses SET type_code = 'electronics' WHERE type_code IS NULL AND lower(trim(type)) IN ('electronics','electronic shop');
UPDATE businesses SET type_code = 'hardware'    WHERE type_code IS NULL AND lower(trim(type)) IN ('hardware','hardware / building materials');
UPDATE businesses SET type_code = 'wholesale'   WHERE type_code IS NULL AND lower(trim(type)) IN ('wholesale','distributor','wholesale / distributor');
UPDATE businesses SET type_code = 'salon'       WHERE type_code IS NULL AND lower(trim(type)) IN ('salon','salon / beauty','salon / barber','barber','beauty','salon / barber shop');
UPDATE businesses SET type_code = 'laundry'     WHERE type_code IS NULL AND lower(trim(type)) IN ('laundry','cleaning','laundry / cleaning');
UPDATE businesses SET type_code = 'garage'      WHERE type_code IS NULL AND lower(trim(type)) IN ('garage','auto parts','auto parts / garage');
UPDATE businesses SET type_code = 'agrovet'     WHERE type_code IS NULL AND lower(trim(type)) IN ('agrovet','farm supply','agrovet / farm supply');
UPDATE businesses SET type_code = 'other'       WHERE type_code IS NULL;