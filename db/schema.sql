PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS expenses;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS purchases;
DROP TABLE IF EXISTS suppliers;
DROP TABLE IF EXISTS stock_movements;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS businesses;
DROP TABLE IF EXISTS cloud_files;
DROP TABLE IF EXISTS mpesa_transactions;
DROP TABLE IF EXISTS mpesa_configurations;

PRAGMA foreign_keys = ON;

CREATE TABLE businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'Shop',
    type_code TEXT,
    enabled_modules TEXT,
    business_features TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    city TEXT,
    country TEXT DEFAULT 'Kenya',
    reg_no TEXT,
    tax_no TEXT,
    currency TEXT DEFAULT 'KES',
    timezone TEXT DEFAULT 'Africa/Nairobi',
    status TEXT DEFAULT 'Active',
    admin_name TEXT,
    admin_email TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE branches (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT,
    location TEXT,
    phone TEXT,
    email TEXT,
    manager TEXT,
    status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    firebase_uid TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    phone TEXT,
    role TEXT NOT NULL DEFAULT 'cashier',
    business_id TEXT,
    branch_id TEXT,
    status TEXT DEFAULT 'active',
    last_login TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    category TEXT,
    brand TEXT,
    cost_price REAL DEFAULT 0,
    selling_price REAL DEFAULT 0,
    offer_price REAL DEFAULT 0,
    stock REAL DEFAULT 0,
    reorder_level REAL DEFAULT 0,
    unit TEXT DEFAULT 'pcs',
    product_type TEXT DEFAULT 'product',
    tax INTEGER DEFAULT 0,
    status TEXT DEFAULT 'Active',
    image TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE TABLE stock_movements (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    type TEXT NOT NULL,
    quantity REAL NOT NULL,
    reason TEXT,
    reference_id TEXT,
    created_by TEXT,
    date TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE TABLE suppliers (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    total_purchases REAL DEFAULT 0,
    outstanding REAL DEFAULT 0,
    status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE purchases (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    supplier_id TEXT,
    supplier_name TEXT,
    date TEXT NOT NULL,
    items TEXT DEFAULT '[]',
    subtotal REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    total REAL DEFAULT 0,
    status TEXT DEFAULT 'Ordered',
    payment_method TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL
);

CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    total_purchases REAL DEFAULT 0,
    balance REAL DEFAULT 0,
    status TEXT DEFAULT 'Active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE sales (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    cashier_id TEXT,
    customer_id TEXT,
    receipt_number TEXT,
    date TEXT NOT NULL,
    items TEXT DEFAULT '[]',
    subtotal REAL DEFAULT 0,
    tax REAL DEFAULT 0,
    discount REAL DEFAULT 0,
    total REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    change_amount REAL DEFAULT 0,
    payment_method TEXT DEFAULT 'Cash',
    status TEXT DEFAULT 'Completed',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
    FOREIGN KEY (cashier_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);
CREATE TABLE refund_requests (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    sale_id TEXT NOT NULL,
    receipt_number TEXT,
    requested_by TEXT,
    requested_by_name TEXT,
    items TEXT DEFAULT '[]',
    amount REAL DEFAULT 0,
    reason TEXT,
    status TEXT DEFAULT 'Pending',
    decided_by TEXT,
    decided_at TEXT,
    decision_notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_refund_requests_business_id ON refund_requests(business_id);
CREATE INDEX idx_refund_requests_sale_id ON refund_requests(sale_id);
CREATE INDEX idx_refund_requests_status ON refund_requests(status);

CREATE TABLE expenses (
    id TEXT PRIMARY KEY,
    business_id TEXT NOT NULL,
    branch_id TEXT,
    category TEXT NOT NULL,
    description TEXT,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    recorded_by TEXT,
    payment_method TEXT DEFAULT 'Cash',
    receipt TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE TABLE settings (
    business_id TEXT PRIMARY KEY,
    receipt_format TEXT DEFAULT 'Standard 80mm',
    receipt_footer TEXT DEFAULT 'Thank you for shopping with us!',
    receipt_prefix TEXT DEFAULT 'RF',
    receipt_numbering TEXT DEFAULT 'date-random',
    receipt_padding INTEGER DEFAULT 6,
    default_payment TEXT DEFAULT 'Cash',
    refund_password TEXT DEFAULT '',
    enable_tax INTEGER DEFAULT 1,
    tax_rate REAL DEFAULT 0,
    enable_discounts INTEGER DEFAULT 1,
    payment_methods TEXT DEFAULT '["Cash","M-Pesa","Card"]',
    date_format TEXT DEFAULT 'DD/MM/YYYY',
    language TEXT DEFAULT 'English',
    enable_email_notifications INTEGER DEFAULT 1,
    enable_audit INTEGER DEFAULT 1,
    receipt_paperless INTEGER DEFAULT 1,
    barcode_scanner INTEGER DEFAULT 0,
    customer_display INTEGER DEFAULT 0,
    staff_reports INTEGER DEFAULT 0,
    staff_refunds INTEGER DEFAULT 0,
    low_stock_alerts INTEGER DEFAULT 0,
    multi_branch INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    action TEXT NOT NULL,
    business_id TEXT,
    branch_id TEXT,
    details TEXT,
    date TEXT DEFAULT (datetime('now')),
    ip TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE SET NULL,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE TABLE cloud_files (
    id TEXT PRIMARY KEY,
    business_id TEXT,
    branch_id TEXT,
    object_key TEXT NOT NULL,
    filename TEXT,
    content_type TEXT,
    size_bytes INTEGER,
    uploaded_by TEXT,
    uploaded_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL
);

CREATE TABLE mpesa_configurations (
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

CREATE TABLE mpesa_transactions (
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

CREATE INDEX idx_mpesa_config_business ON mpesa_configurations(business_id);
CREATE INDEX idx_mpesa_config_enabled ON mpesa_configurations(enabled);
CREATE INDEX idx_mpesa_config_status ON mpesa_configurations(connection_status);

CREATE INDEX idx_mpesa_transactions_business ON mpesa_transactions(business_id);
CREATE INDEX idx_mpesa_transactions_branch ON mpesa_transactions(branch_id);
CREATE INDEX idx_mpesa_transactions_sale ON mpesa_transactions(sale_id);
CREATE INDEX idx_mpesa_transactions_checkout ON mpesa_transactions(checkout_request_id);
CREATE INDEX idx_mpesa_transactions_merchant ON mpesa_transactions(merchant_request_id);
CREATE INDEX idx_mpesa_transactions_receipt ON mpesa_transactions(mpesa_receipt_number);
CREATE INDEX idx_mpesa_transactions_status ON mpesa_transactions(status);
CREATE INDEX idx_mpesa_transactions_created ON mpesa_transactions(created_at);

CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_business_id ON users(business_id);
CREATE INDEX idx_users_branch_id ON users(branch_id);
CREATE INDEX idx_users_role ON users(role);

CREATE INDEX idx_businesses_status ON businesses(status);
CREATE INDEX idx_businesses_type ON businesses(type);
CREATE INDEX idx_businesses_type_code ON businesses(type_code);

CREATE INDEX idx_branches_business_id ON branches(business_id);
CREATE INDEX idx_branches_status ON branches(status);

CREATE INDEX idx_products_business_id ON products(business_id);
CREATE INDEX idx_products_branch_id ON products(branch_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_barcode ON products(barcode);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_product_type ON products(product_type);

CREATE INDEX idx_stock_product_id ON stock_movements(product_id);
CREATE INDEX idx_stock_business_id ON stock_movements(business_id);
CREATE INDEX idx_stock_branch_id ON stock_movements(branch_id);
CREATE INDEX idx_stock_date ON stock_movements(date);

CREATE INDEX idx_suppliers_business_id ON suppliers(business_id);
CREATE INDEX idx_suppliers_name ON suppliers(name);

CREATE INDEX idx_purchases_business_id ON purchases(business_id);
CREATE INDEX idx_purchases_branch_id ON purchases(branch_id);
CREATE INDEX idx_purchases_supplier_id ON purchases(supplier_id);
CREATE INDEX idx_purchases_date ON purchases(date);

CREATE INDEX idx_customers_business_id ON customers(business_id);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_phone ON customers(phone);

CREATE INDEX idx_sales_business_id ON sales(business_id);
CREATE INDEX idx_sales_branch_id ON sales(branch_id);
CREATE INDEX idx_sales_cashier_id ON sales(cashier_id);
CREATE INDEX idx_sales_customer_id ON sales(customer_id);
CREATE INDEX idx_sales_date ON sales(date);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_receipt_number ON sales(receipt_number);
CREATE INDEX idx_refund_requests_business_id ON refund_requests(business_id);
CREATE INDEX idx_refund_requests_sale_id ON refund_requests(sale_id);
CREATE INDEX idx_refund_requests_status ON refund_requests(status);

CREATE INDEX idx_expenses_business_id ON expenses(business_id);
CREATE INDEX idx_expenses_branch_id ON expenses(branch_id);
CREATE INDEX idx_expenses_category ON expenses(category);
CREATE INDEX idx_expenses_date ON expenses(date);

CREATE INDEX idx_audit_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_business_id ON audit_logs(business_id);
CREATE INDEX idx_audit_branch_id ON audit_logs(branch_id);
CREATE INDEX idx_audit_date ON audit_logs(date);

CREATE INDEX idx_cloud_files_business_id ON cloud_files(business_id);
CREATE INDEX idx_cloud_files_branch_id ON cloud_files(branch_id);
CREATE INDEX idx_cloud_files_object_key ON cloud_files(object_key);