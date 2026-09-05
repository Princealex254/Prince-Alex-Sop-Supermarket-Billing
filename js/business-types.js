/* ==================================================================
   RetailFlow — js/business-types.js
   --------------------------------------------------------------
   The single source of truth for business-type configuration.

   RetailFlow is ONE core platform, configured per business type
   instead of fifteen separate POS systems:

     type_code              — machine identity of the business type
     enabled_modules        — which specialised modules appear in the
                              interface (null = "auto, follow the type")
     business_features      — capability flags that light up optional
                              fields and workflows later
     products.product_type  — what an item in the catalogue is
                              (product | menu_item | drink | service | addon)

   The POS, the Owner console and the Worker all read from this one
   registry. Adding a new business type = adding one entry below;
   nothing else needs restructuring.
   ================================================================== */

/* ----------------------------------------------------------------
   MODULE CATALOG
   status: "live"    — the module has full UI today
           "planned" — declared now; the UI ships in a later phase
                       and lights up automatically (no config changes)
   ---------------------------------------------------------------- */
export const MODULE_CATALOG = {
  /* ---- Core modules (every business) ---- */
  overview:   { label: "Overview",    icon: "fa-gauge-high",          group: "manage",     status: "live" },
  staff:      { label: "Staff",       icon: "fa-user-gear",           group: "manage",     status: "live" },
  branches:   { label: "Branches",    icon: "fa-code-branches",       group: "manage",     status: "live" },
  products:   { label: "Products",    icon: "fa-cube",                group: "manage",     status: "live" },
  inventory:  { label: "Inventory",   icon: "fa-warehouse",           group: "operations", status: "live" },
  sales:      { label: "Sales",       icon: "fa-receipt",             group: "operations", status: "live" },
  purchases:  { label: "Purchases",   icon: "fa-cart-shopping",       group: "operations", status: "live" },
  customers:  { label: "Customers",   icon: "fa-user-group",          group: "operations", status: "live" },
  suppliers:  { label: "Suppliers",   icon: "fa-truck",               group: "operations", status: "live" },
  expenses:   { label: "Expenses",    icon: "fa-money-bill-transfer", group: "operations", status: "live" },
  reports:    { label: "Reports",     icon: "fa-chart-line",          group: "operations", status: "live" },
  audit:      { label: "Audit Logs",  icon: "fa-clipboard-list",      group: "manage",     status: "live" },
  settings:   { label: "Settings",    icon: "fa-gear",                group: "manage",     status: "live" },

  /* ---- Platform-owner level ---- */
  businesses: { label: "Businesses",  icon: "fa-briefcase",           group: "manage",     status: "live" },

  /* ---- Planned specialised modules (Phase 3) ---- */
  tables:         { label: "Tables",         icon: "fa-table-cells-large",    group: "special", status: "planned" },
  orders:         { label: "Orders",         icon: "fa-clipboard-list-check", group: "special", status: "planned" },
  kitchen:        { label: "Kitchen",        icon: "fa-fire-burner",          group: "special", status: "planned" },
  tabs:           { label: "Tabs",           icon: "fa-martini-glass",        group: "special", status: "planned" },
  services:       { label: "Services",       icon: "fa-scissors",             group: "special", status: "planned" },
  appointments:   { label: "Appointments",   icon: "fa-calendar-check",       group: "special", status: "planned" },
  guest_accounts: { label: "Guest Accounts", icon: "fa-bed",                  group: "special", status: "planned" }
};

/* Modules every business gets by default. "Businesses" and "Audit Logs"
   stay platform/owner-level (still reachable for platform owners). */
export const CORE_MODULES = [
  "overview", "staff", "branches", "products", "inventory", "sales",
  "purchases", "customers", "suppliers", "expenses", "reports", "settings"
];

/* ----------------------------------------------------------------
   FEATURES — capability flags that turn optional workflows / fields
   on for a type. Displayed read-only in V1; per-business overrides
   can be stored in business_features.
   ---------------------------------------------------------------- */
export const FEATURE_META = {
  barcode:          { label: "Barcode scanning",     icon: "fa-barcode" },
  multiBranch:      { label: "Multi-branch",         icon: "fa-code-branches" },
  variants:         { label: "Sizes & colours",      icon: "fa-shirt" },
  serials:          { label: "Serial numbers",       icon: "fa-hashtag" },
  warranty:         { label: "Warranty tracking",    icon: "fa-shield-halved" },
  batches:          { label: "Batch numbers",        icon: "fa-layer-group" },
  expiry:           { label: "Expiry tracking",      icon: "fa-clock" },
  customUnits:      { label: "Measurement units",    icon: "fa-ruler" },
  bulkPricing:      { label: "Bulk pricing",         icon: "fa-cubes-stacked" },
  creditSales:      { label: "Credit sales",         icon: "fa-hand-holding-dollar" },
  customerAccounts: { label: "Customer accounts",    icon: "fa-user-tie" },
  tableService:     { label: "Table service",        icon: "fa-table-cells-large" },
  kitchen:          { label: "Kitchen tickets",      icon: "fa-fire-burner" },
  takeaway:         { label: "Takeaway",             icon: "fa-bag-shopping" },
  tabs:             { label: "Open / close tabs",    icon: "fa-martini-glass" },
  guestAccounts:    { label: "Room / guest billing", icon: "fa-bed" },
  serviceItems:     { label: "Services",             icon: "fa-scissors" },
  appointments:     { label: "Appointments",         icon: "fa-calendar-check" },
  commission:       { label: "Staff commission",     icon: "fa-percent" },
  orderStatus:      { label: "Order status",         icon: "fa-arrows-rotate" },
  vehicles:         { label: "Vehicle records",      icon: "fa-car" },
  laundryStatus:    { label: "Laundry workflow",     icon: "fa-shirt" }
};

/* ----------------------------------------------------------------
   BUSINESS TYPE DEFINITIONS
   ---------------------------------------------------------------- */
export const BUSINESS_TYPE_DEFS = [
  {
    code: "retail", label: "Retail / Shop", icon: "fa-store",
    tagline: "General shops, mini-marts and convenience stores.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for shopping with us!",
    modules: [], features: {}
  },
  {
    code: "supermarket", label: "Supermarket", icon: "fa-cart-shopping",
    tagline: "Barcode scanning, large catalogues, stock and many branches.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for shopping with us!",
    modules: [], features: { barcode: true, multiBranch: true, expiry: true }
  },
  {
    code: "restaurant", label: "Restaurant", icon: "fa-utensils",
    tagline: "Tables, orders, kitchen workflow, takeaway and dine-in.",
    productLabel: "Menu", cartLabel: "Order",
    receiptFooter: "Thank you for dining with us!",
    modules: ["tables", "orders", "kitchen"],
    features: { tableService: true, kitchen: true, takeaway: true, orderStatus: true }
  },
  {
    code: "cafe", label: "Café / Coffee Shop", icon: "fa-mug-hot",
    tagline: "Quick sales, custom orders, takeaway and simple inventory.",
    productLabel: "Menu", cartLabel: "Order",
    receiptFooter: "Thank you for visiting us!",
    modules: ["orders"],
    features: { takeaway: true }
  },
  {
    code: "bar", label: "Bar / Lounge", icon: "fa-martini-glass",
    tagline: "Tables, waiters, open tabs, split payments and drinks inventory.",
    productLabel: "Drinks", cartLabel: "Tab",
    receiptFooter: "Thank you for joining us!",
    modules: ["tables", "orders", "tabs"],
    features: { tableService: true, tabs: true, orderStatus: true }
  },
  {
    code: "hotel", label: "Hotel", icon: "fa-bed",
    tagline: "Restaurant/bar POS, room charges, multiple outlets and guests.",
    productLabel: "Items", cartLabel: "Guest Bill",
    receiptFooter: "Thank you for choosing us — we hope to welcome you back soon!",
    modules: ["tables", "orders", "guest_accounts"],
    features: { tableService: true, guestAccounts: true, multiBranch: true, orderStatus: true }
  },
  {
    code: "pharmacy", label: "Pharmacy", icon: "fa-prescription-bottle-medical",
    tagline: "Product/barcode management, batch numbers and expiry tracking.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for trusting us with your health!",
    modules: [],
    features: { barcode: true, batches: true, expiry: true }
  },
  {
    code: "clothing", label: "Fashion / Clothing", icon: "fa-shirt",
    tagline: "Sizes, colours, product variants, barcode and SKU management.",
    productLabel: "Items", cartLabel: "Cart",
    receiptFooter: "Thank you for shopping with us!",
    modules: [],
    features: { variants: true, barcode: true }
  },
  {
    code: "electronics", label: "Electronics", icon: "fa-laptop",
    tagline: "Serial numbers, warranty information and product inventory.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for choosing us!",
    modules: [],
    features: { serials: true, warranty: true, barcode: true }
  },
  {
    code: "hardware", label: "Hardware / Building Materials", icon: "fa-hammer",
    tagline: "Units, measurement types, bulk quantities and suppliers.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for building with us!",
    modules: [],
    features: { customUnits: true, bulkPricing: true }
  },
  {
    code: "wholesale", label: "Wholesale / Distributor", icon: "fa-boxes-packing",
    tagline: "Bulk pricing, credit sales, supplier management and branches.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for your business!",
    modules: [],
    features: { bulkPricing: true, creditSales: true, customerAccounts: true, multiBranch: true }
  },
  {
    code: "salon", label: "Salon / Barber Shop", icon: "fa-scissors",
    tagline: "Services, staff, appointments, product sales and commissions.",
    productLabel: "Services", cartLabel: "Booking",
    receiptFooter: "Thank you! See you soon!",
    modules: ["services", "appointments"],
    features: { serviceItems: true, appointments: true, commission: true }
  },
  {
    code: "laundry", label: "Laundry / Cleaning", icon: "fa-soap",
    tagline: "Service orders, customer records, order status and payments.",
    productLabel: "Services", cartLabel: "Order",
    receiptFooter: "Thank you for your business!",
    modules: ["services"],
    features: { serviceItems: true, laundryStatus: true, orderStatus: true, customerAccounts: true }
  },
  {
    code: "garage", label: "Auto Parts / Garage", icon: "fa-car",
    tagline: "Parts inventory, SKU/barcodes, vehicle records and service charges.",
    productLabel: "Parts", cartLabel: "Job",
    receiptFooter: "Thank you for trusting us with your vehicle!",
    modules: [],
    features: { barcode: true, serials: true, vehicles: true, serviceItems: true }
  },
  {
    code: "agrovet", label: "Agrovet / Farm Supply", icon: "fa-tractor",
    tagline: "Products, stock, suppliers, customer accounts and sales tracking.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for your business!",
    modules: [],
    features: { creditSales: true, customerAccounts: true, customUnits: true }
  },
  {
    code: "other", label: "Other Business", icon: "fa-briefcase",
    tagline: "Flexible enough to run almost any growing SME.",
    productLabel: "Products", cartLabel: "Cart",
    receiptFooter: "Thank you for your business!",
    modules: [], features: {}
  }
];

/* Legacy type strings we keep accepting (existing data + old UI). */
const LEGACY_TYPE_MAP = {
  "shop": "retail", "retail": "retail", "retail / shop": "retail", "retail shop": "retail", "general": "retail",
  "supermarket": "supermarket",
  "restaurant": "restaurant",
  "café": "cafe", "cafe": "cafe", "cafes": "cafe", "café / coffee shop": "cafe",
  "bar": "bar", "bar / lounge": "bar", "lounge": "bar",
  "hotel": "hotel",
  "pharmacy": "pharmacy", "chemist": "pharmacy",
  "clothing": "clothing", "fashion": "clothing", "boutique": "clothing", "fashion / clothing": "clothing",
  "electronics": "electronics", "electronic shop": "electronics",
  "hardware": "hardware", "hardware / building materials": "hardware",
  "wholesale": "wholesale", "distributor": "wholesale", "wholesale / distributor": "wholesale",
  "salon": "salon", "salon / beauty": "salon", "salon / barber": "salon", "barber": "salon", "beauty": "salon", "salon / barber shop": "salon",
  "laundry": "laundry", "cleaning": "laundry", "laundry / cleaning": "laundry",
  "garage": "garage", "auto parts": "garage", "auto parts / garage": "garage",
  "agrovet": "agrovet", "farm supply": "agrovet", "agrovet / farm supply": "agrovet",
  "other": "other"
};

/* Normalise any legacy type label (or already-normal code) to a code. */
export function normalizeTypeCode(value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  return LEGACY_TYPE_MAP[s] || "other";
}

/* Resolve a business row's type code (camelCase or snake_case row). */
export function businessTypeCode(biz) {
  if (!biz) return "other";
  const c = biz.typeCode ?? biz.type_code ?? biz.type;
  return normalizeTypeCode(c);
}

/* Full definition for a type code; unknown codes fall back to "other". */
export function typeDef(code) {
  const c = normalizeTypeCode(code);
  return BUSINESS_TYPE_DEFS.find((d) => d.code === c) || BUSINESS_TYPE_DEFS[BUSINESS_TYPE_DEFS.length - 1];
}

/* Friendly label for a business row's type ("Supermarket", "Salon / Barber Shop", …). */
export function businessTypeLabel(biz) {
  return typeDef(businessTypeCode(biz)).label;
}

/* ---- Stored field parsing (may arrive as JSON text or already parsed) ---- */
function parseArray(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { const a = JSON.parse(raw); return Array.isArray(a) ? a : null; } catch (e) { return null; }
  }
  return null;
}
function parseObject(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { const o = JSON.parse(raw); return (o && typeof o === "object" && !Array.isArray(o)) ? o : null; } catch (e) { return null; }
  }
  return null;
}

/* Which modules does this business use? Returns CORE + specialised.
   A stored enabled_modules array is authoritative (empty = explicitly
   none); an absent/invalid value means "auto — follow the type defaults".
   opts.hidePlanned removes modules whose UI has not shipped yet. */
export function modulesForBusiness(biz, opts = {}) {
  const def = typeDef(businessTypeCode(biz));
  const stored = enabledModulesFor(biz);
  const extra = Array.isArray(stored) ? stored : def.modules;
  const list = [...new Set(CORE_MODULES.concat(extra))];
  if (opts && opts.hidePlanned) {
    return list.filter((m) => (MODULE_CATALOG[m] || {}).status !== "planned");
  }
  return list;
}

/* Capability flags for a business: type defaults merged with any
   per-business override stored in business_features. */
export function featuresForBusiness(biz) {
  const def = typeDef(businessTypeCode(biz));
  const stored = storedFeatures(biz);
  return Object.assign({}, def.features, stored || {});
}

/* Friendly labels for the sales catalogue (per type). */
export function businessLabels(biz) {
  const def = typeDef(businessTypeCode(biz));
  return { product: def.productLabel, cart: def.cartLabel };
}

/* Default receipt footer message for this business type. Used when the
   business has not set a custom footer (or still has the legacy generic
   one). Owners can always override via Settings → POS → Receipt footer. */
export function receiptFooterFor(biz) {
  return typeDef(businessTypeCode(biz)).receiptFooter || "Thank you for your business!";
}

/* Convenience lists for pickers / previews. */
export const BUSINESS_TYPE_OPTIONS = BUSINESS_TYPE_DEFS.map((d) => ({
  value: d.code, label: d.label, icon: d.icon, tagline: d.tagline
}));

/* Specialised (non-core) modules a business type may toggle on/off. */
export const SPECIAL_MODULES = Object.keys(MODULE_CATALOG).filter((m) =>
  CORE_MODULES.indexOf(m) === -1 && m !== "businesses" && m !== "audit"
);

/* Raw stored overrides (parsed), or null when not set / invalid.
   enabledModulesFor → array | null
   storedFeatures    → object | null                                    */
export function enabledModulesFor(biz) {
  return parseArray(biz && (biz.enabledModules ?? biz.enabled_modules));
}
export function storedFeatures(biz) {
  return parseObject(biz && (biz.businessFeatures ?? biz.business_features));
}