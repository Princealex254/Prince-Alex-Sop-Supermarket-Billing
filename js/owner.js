/* ==================================================================
   RetailFlow — owner.js
   --------------------------------------------------------------
   The RetailFlow Administration System (owner/index.html).

   RESPONSIBILITIES
     • Verify the Firebase session (redirect to login if none).
     • Load the user's application role.
     • Render a role-aware administration interface.
     • Manage businesses, staff, branches, products, inventory,
       sales, purchases, customers, suppliers, expenses, reports,
       audit logs and settings.

   SECURITY MODEL (IMPORTANT)
     The frontend decides only what UI to SHOW.
     Authorization is enforced by the backend:
       Store Manager
          ↓
       requests another business's sales
          ↓
       Cloudflare Worker → Permission denied
     Even if someone tampers with this file, the backend must
     still reject unauthorized requests. Every API function below
     is a marked integration point for that Cloudflare Worker.

   FUTURE DATA FLOW
     Frontend
        ↓
     Firebase Auth
        ↓
     Firebase ID Token
        ↓
     Cloudflare Worker
        ↓
     Authorization (role, business_id, branch_id)
        ↓
     Cloudflare D1
   ================================================================== */

import { auth, onAuthStateChanged, signOut, db as fsDB, doc, setDoc, deleteDoc, serverTimestamp, FIREBASE_API_KEY } from "../firebase/firebase-config.js";
import {
  BUSINESS_TYPE_OPTIONS, FEATURE_META, MODULE_CATALOG, SPECIAL_MODULES, enabledModulesFor,
  normalizeTypeCode, typeDef, modulesForBusiness, featuresForBusiness, businessTypeCode, businessTypeLabel,
  receiptFooterFor
} from "./business-types.js";

/* ---------------- State ---------------- */
const state = {
  user: null,                       // Firebase user
  profile: null,                    // { id, name, email, role, businessId, branchId }
  view: "overview",                 // active sidebar section
  settingsTab: "business",          // active settings sub-tab
  businessTab: "overview",          // active business-detail modal tab
  charts: {},                       // live Chart.js instances
  redirecting: false,
  filters: {},                      // per-view search/filter/sort/pagination
  authed: false
};

/* ---------------- API client (Cloudflare Worker) ----------------
   All data + media is routed through the RetailFlow Cloudflare
   Worker at API_BASE. The Firebase ID token is attached as
   `Authorization: Bearer <token>` on every request. The Worker
   verifies the token, resolves the D1 user, checks role +
   business_id + branch_id and enforces permissions server-side.
   The frontend only decides what UI to show.
   ----------------------------------------------------------------- */
const API_BASE = "https://retailflow-api.princealexdigital.workers.dev";

const ROLE_VALUE = {
  "Admin": "admin", "Store Manager": "store_manager", "Cashier": "cashier",
  "Inventory Manager": "inventory_manager", "Accountant": "accountant",
  "Waiter": "waiter", "Sales Staff": "sales_staff", "Custom": "custom"
};
const ROLE_DISPLAY = {
  owner: "Platform Owner", admin: "Admin", store_manager: "Store Manager",
  cashier: "Cashier", inventory_manager: "Inventory Manager", accountant: "Accountant",
  waiter: "Waiter", sales_staff: "Sales Staff", custom: "Custom"
};

async function apiToken() {
  if (!state.user) throw new Error("Not signed in");
  return await state.user.getIdToken(true);
}

/* Perform an authenticated request to the Worker; throws on HTTP error. */
async function apiRequest(path, options = {}) {
  const token = await apiToken();
  const res = await fetch(API_BASE + path, {
    method: options.method || "GET",
    headers: Object.assign(
      { Authorization: "Bearer " + token },
      options.body ? { "Content-Type": "application/json" } : {},
      options.headers || {}
    ),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ("Request failed (" + res.status + ")");
    const err = new Error(msg); err.status = res.status;
    throw err;
  }
  return data || {};
}

/* Upload a file (multipart/form-data) — product images are stored in
   Cloudflare R2 via POST /upload and served from GET /files/<key>. */
async function apiUploadImage(file, businessId) {
  const token = await apiToken();
  const form = new FormData();
  form.append("file", file, file.name);
  if (businessId) form.append("businessId", businessId);
  const res = await fetch(API_BASE + "/upload", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: form
  });
  let data = null;
  try { data = await res.json(); } catch (e) { }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ("Upload failed (" + res.status + ")");
    const err = new Error(msg); err.status = res.status;
    throw err;
  }
  return data || {};
}

/* ---------- Response normaliser: snake_case → camelCase ---------- */
function camelize(key) { return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()); }

const FIELD_MAP = {
  business: { created_at: "createdAt", updated_at: "updatedAt", reg_no: "regNo", tax_no: "taxNo", admin_name: "adminName", admin_email: "adminEmail", type_code: "typeCode", enabled_modules: "enabledModules", business_features: "businessFeatures" },
  branch:   { business_id: "businessId", created_at: "createdAt", updated_at: "updatedAt" },
  staff:    { firebase_uid: "firebaseUid", business_id: "businessId", branch_id: "branchId", last_login: "lastLogin", created_at: "createdAt", updated_at: "updatedAt" },
  product:  { business_id: "businessId", branch_id: "branchId", cost_price: "cost", selling_price: "price", offer_price: "offerPrice", reorder_level: "reorderLevel", product_type: "productType", created_at: "createdAt", updated_at: "updatedAt" },
  sale:     { business_id: "businessId", branch_id: "branchId", business_name: "businessName", branch_name: "branchName", customer_name: "customer", cashier_name: "cashier", payment_method: "method", total: "amount", receipt_number: "receiptNumber", mpesa_receipt_number: "mpesaReceiptNumber", created_at: "createdAt" },
  purchase: { business_id: "businessId", branch_id: "branchId", supplier_name: "supplier", payment_method: "method", created_by: "createdBy", created_at: "createdAt", updated_at: "updatedAt" },
  customer: { business_id: "businessId", total_purchases: "totalPurchases", last_purchase: "lastPurchase", created_at: "createdAt", updated_at: "updatedAt" },
  supplier: { business_id: "businessId", contact_person: "contact", total_purchases: "totalPurchases", created_at: "createdAt", updated_at: "updatedAt" },
  expense:  { business_id: "businessId", branch_id: "branchId", recorded_by: "recordedBy", payment_method: "method", created_at: "createdAt", updated_at: "updatedAt" },
  audit:    { user_id: "userId", user_name: "user", user_email: "userEmail", business_id: "businessId", branch_id: "branchId", created_at: "date" },
  profile:  { firebase_uid: "firebaseUid", business_id: "businessId", branch_id: "branchId", last_login: "lastLogin", needs_onboarding: "needsOnboarding" }
};

function normalizeRow(row, type) {
  if (!row || typeof row !== "object") return row || {};
  const map = FIELD_MAP[type] || {};
  const out = {};
  Object.keys(row).forEach((k) => { out[map[k] || camelize(k)] = row[k]; });
  return out;
}
function normalizeList(rows, type) { return (rows || []).map((r) => normalizeRow(r, type)); }

function upsert(list, item) {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx >= 0) list[idx] = item; else list.unshift(item);
  return item;
}

function roleLabel(role) { return ROLE_DISPLAY[role] || ROLE_LABELS[role] || role || "—"; }

/* Scope-aware list loader. Owner iterates all businesses; admin /
   store manager are locked to their business (and branch where
   relevant). The Worker is the source of truth for scoping. */
async function apiGetScopedList(path, resKey, type, cacheKey, opts = {}) {
  const p = state.profile || {};
  let ids = [];
  if (opts.businessId) ids = [opts.businessId];
  else if (p.role === "owner") ids = db.businesses.map((b) => b.id).filter(Boolean);
  else ids = [p.businessId].filter(Boolean);
  if (!ids.length) { db[cacheKey] = []; return db[cacheKey]; }
  let all = [];
  for (const bId of ids) {
    const q = new URLSearchParams({ businessId: bId });
    if (opts.branchId) q.set("branchId", opts.branchId);
    if (opts.status) q.set("status", opts.status);
    if (opts.search) q.set("search", opts.search);
    if (opts.category) q.set("category", opts.category);
    const data = await apiRequest(path + "?" + q.toString());
    all = all.concat(normalizeList(data[resKey], type));
  }
  db[cacheKey] = all;
  return db[cacheKey];
}

function resetDbCache() {
  Object.keys(db).forEach((k) => { db[k] = (k === "settings") ? {} : []; });
}

/* Preload the data the UI needs after login. */
async function loadAllData() {
  resetDbCache();
  await apiGetBusinesses();
  const p = state.profile || {};
  await Promise.allSettled([
    apiGetStaff(),
    apiGetBranches(),
    apiGetProducts(p.businessId, p.branchId),
    apiGetSales(p.businessId, p.branchId),
    apiGetRefunds(p.businessId, p.branchId),
    apiGetPurchases(p.businessId),
    apiGetCustomers(p.businessId),
    apiGetSuppliers(p.businessId),
    apiGetExpenses(p.businessId, p.branchId)
  ]);
}

/* ---------------- DOM refs ---------------- */
const $ = (id) => document.getElementById(id);
const loadingEl = $("appLoading");
const deniedEl = $("deniedScreen");
const shellEl = $("appShell");
const sideNav = $("sideNav");
const sidebarContext = $("sidebarContext");
const contentEl = $("content");
const pageTitle = $("pageTitle");
const pageSub = $("pageSub");
const scopeChip = $("scopeChip");
const modalRoot = $("modalRoot");
/* ---------------- Role + navigation config ---------------- */
const ALLOWED_ROLES = ["owner", "admin", "store_manager"];
const ROLE_LABELS = { owner: "Platform Owner", admin: "Business Admin", store_manager: "Store Manager" };

const NAV = {
  owner: [
    { key: "overview",    icon: "fa-gauge-high",          label: "Overview" },
    { key: "businesses",  icon: "fa-briefcase",           label: "Businesses" },
    { key: "staff",       icon: "fa-user-gear",           label: "Staff & Users" },
    { key: "branches",    icon: "fa-code-branches",       label: "Branches" },
    { key: "products",    icon: "fa-cube",                label: "Products" },
    { key: "inventory",   icon: "fa-warehouse",           label: "Inventory" },
    { key: "sales",       icon: "fa-receipt",             label: "Sales" },
    { key: "mpesa",       icon: "fa-mobile-screen-button", label: "M-Pesa" },
    { key: "refunds",     icon: "fa-rotate-left",         label: "Refunds" },
    { key: "purchases",   icon: "fa-cart-shopping",       label: "Purchases" },
    { key: "customers",   icon: "fa-user-group",          label: "Customers" },
    { key: "suppliers",   icon: "fa-truck",               label: "Suppliers" },
    { key: "expenses",    icon: "fa-money-bill-transfer", label: "Expenses" },
    { key: "reports",     icon: "fa-chart-line",          label: "Reports" },
    { key: "audit",       icon: "fa-clipboard-list",      label: "Audit Logs" },
    { key: "settings",    icon: "fa-gear",                label: "Settings" }
  ],
  admin: [
    { key: "overview",    icon: "fa-gauge-high",          label: "Overview" },
    { key: "staff",       icon: "fa-user-gear",           label: "Staff & Users" },
    { key: "branches",    icon: "fa-code-branches",       label: "Branches" },
    { key: "products",    icon: "fa-cube",                label: "Products" },
    { key: "inventory",   icon: "fa-warehouse",           label: "Inventory" },
    { key: "sales",       icon: "fa-receipt",             label: "Sales" },
    { key: "mpesa",       icon: "fa-mobile-screen-button", label: "M-Pesa" },
    { key: "refunds",     icon: "fa-rotate-left",         label: "Refunds" },
    { key: "purchases",   icon: "fa-cart-shopping",       label: "Purchases" },
    { key: "customers",   icon: "fa-user-group",          label: "Customers" },
    { key: "suppliers",   icon: "fa-truck",               label: "Suppliers" },
    { key: "expenses",    icon: "fa-money-bill-transfer", label: "Expenses" },
    { key: "reports",     icon: "fa-chart-line",          label: "Reports" },
    { key: "settings",    icon: "fa-gear",                label: "Settings" }
  ],
  store_manager: [
    { key: "overview",    icon: "fa-gauge-high",          label: "Overview" },
    { key: "staff",       icon: "fa-user-gear",           label: "Staff" },
    { key: "products",    icon: "fa-cube",                label: "Products" },
    { key: "inventory",   icon: "fa-warehouse",           label: "Inventory" },
    { key: "sales",       icon: "fa-receipt",             label: "Sales" },
    { key: "mpesa",       icon: "fa-mobile-screen-button", label: "M-Pesa" },
    { key: "refunds",     icon: "fa-rotate-left",         label: "Refunds" },
    { key: "customers",   icon: "fa-user-group",          label: "Customers" },
    { key: "expenses",    icon: "fa-money-bill-transfer", label: "Expenses" },
    { key: "reports",     icon: "fa-chart-line",          label: "Reports" },
    { key: "settings",    icon: "fa-gear",                label: "Settings" }
  ]
};

const PAGE_META = {
  overview:    { title: "Overview",      sub: "Here's what's happening across your business." },
  businesses:  { title: "Businesses",    sub: "Manage the businesses on the RetailFlow platform." },
  staff:       { title: "Staff & Users", sub: "Manage staff, roles and branch assignments." },
  branches:    { title: "Branches",      sub: "Manage business locations and branches." },
  products:    { title: "Products",      sub: "Create and manage your catalogue." },
  inventory:   { title: "Inventory",     sub: "Track stock levels and inventory movement." },
  sales:       { title: "Sales",         sub: "Review transactions and payment performance." },
  mpesa:       { title: "M-Pesa Payments", sub: "M-Pesa transactions collected through RetailFlow." },
  refunds:     { title: "Refunds",       sub: "Review and approve refund requests submitted from the POS." },
  purchases:   { title: "Purchases",     sub: "Manage suppliers and incoming stock." },
  customers:   { title: "Customers",     sub: "Your customer base and purchase history." },
  suppliers:   { title: "Suppliers",     sub: "Manage suppliers and procurement." },
  expenses:    { title: "Expenses",      sub: "Track where your money goes." },
  reports:     { title: "Reports",       sub: "Turn your business data into insights." },
  audit:       { title: "Audit Logs",    sub: "A record of important platform actions." },
  settings:    { title: "Settings",      sub: "Business, POS, permissions and system settings." }
};
/* ---------------- Constants ---------------- */
/* Business-type configuration comes from the shared registry
   (js/business-types.js). Kept as a label list for legacy call sites. */
const BUSINESS_TYPES = BUSINESS_TYPE_OPTIONS.map((t) => t.label);
const STAFF_ROLES = [
  "Admin", "Store Manager", "Cashier", "Inventory Manager",
  "Accountant", "Waiter", "Sales Staff", "Custom"
];
const PAYMENT_METHODS = ["Cash", "M-Pesa", "Card", "Bank", "Other"];
const CURRENCIES = ["KES", "UGX", "TZS", "RWF", "USD", "GBP", "EUR", "ZAR", "NGN", "GHS", "ETB"];
const TIMEZONES = [
  "Africa/Nairobi", "Africa/Kampala", "Africa/Dar es Salaam", "Africa/Kigali",
  "Africa/Addis Ababa", "Africa/Accra", "Africa/Lagos", "Africa/Johannesburg", "UTC"
];
// Dynamic categories - can be extended by user
let PRODUCT_CATEGORIES = ["Groceries", "Beverages", "Electronics", "Hardware", "Health & Beauty", "General"];

/* ---------------- Utility helpers ---------------- */
function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(amount, currency) {
  const cur = currency || "KES";
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  return cur + " " + fmt.format(Number(amount) || 0);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function initials(name) {
  return String(name || "?").split(" ").filter(Boolean).slice(0, 2)
    .map((w) => w[0].toUpperCase()).join("");
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function uid(prefix) {
  return (prefix || "id") + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* Cryptographically-random temporary password for newly provisioned staff accounts. */
function randomTempPassword(len) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const n = len || 12;
  const bytes = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  let pw = "";
  for (let i = 0; i < n; i++) pw += chars[bytes[i] % chars.length];
  return pw;
}

/* ---------------- Toast notifications ---------------- */
function showToast(type, title, message) {
  const icons = { success: "fa-circle-check", error: "fa-circle-exclamation", info: "fa-circle-info" };
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML =
    '<span class="toast-icon" aria-hidden="true"><i class="fa-solid ' + (icons[type] || icons.info) + '"></i></span>' +
    '<div class="toast-body"><strong></strong><p></p></div>' +
    '<button type="button" class="toast-x" aria-label="Dismiss notification">✕</button>';
  toast.querySelector(".toast-body strong").textContent = title;
  toast.querySelector(".toast-body p").textContent = message;

  $("toastStack").appendChild(toast);

  let closing = false;
  let timer = null;
  const dismiss = () => {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove());
  };
  toast.querySelector(".toast-x").addEventListener("click", dismiss);
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, 1600); });
  timer = setTimeout(dismiss, 4600);
}

/* ---------------- Small validation helpers ---------------- */
const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

function setFieldError(fieldEl, message) {
  fieldEl.classList.add("has-error");
  const span = fieldEl.querySelector(".field-error span");
  if (span) span.textContent = message;
  const input = fieldEl.querySelector("input,select,textarea");
  if (input) input.setAttribute("aria-invalid", "true");
}

function clearFieldError(fieldEl) {
  fieldEl.classList.remove("has-error");
  const input = fieldEl.querySelector("input,select,textarea");
  if (input) input.removeAttribute("aria-invalid");
}

function setButtonLoading(btn, loading, busyText) {
  if (loading) {
    btn.classList.add("is-loading");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (busyText) btn.dataset.busyLabel = busyText;
  } else {
    btn.classList.remove("is-loading");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}
/* ================================================================
   MOCK DATA + API LAYER
   ----------------------------------------------------------------
   All data below is temporary mock data that mirrors the shape of
   the records that will be returned by the real backend
   (Cloudflare Workers + D1). Every record that belongs to a tenant
   carries business_id and, where relevant, branch_id — this
   multi-tenant shape is what the frontend is being built around.

   API INTEGRATION POINT:
   Replace the bodies of the functions at the bottom of this file
   with calls to the Cloudflare Worker API, e.g.:

     async function getBusinesses() {
       const idToken = await state.user.getIdToken();
       const res = await fetch("https://api.retailflow.example/owner/businesses", {
         headers: { Authorization: "Bearer " + idToken }
       });
       if (!res.ok) throw new Error("Failed to load businesses");
       return res.json();
     }

   The Worker must always enforce:
     1. Firebase ID token is valid
     2. user identity + role
     3. business_id / branch_id assignment
     4. the requested action is permitted for that role
   ================================================================ */

const B1 = "biz-supermart";
const B2 = "biz-cafe";
const B3 = "biz-restaurant";
const B4 = "biz-hardware";
const B5 = "biz-pharmacy";
const B6 = "biz-electronics";

let db = {
  businesses: [
    { id: B1, name: "ABC Supermarket", type: "Supermarket", phone: "+254 712 000 111", email: "hello@abcsupermarket.co.ke", address: "Moi Avenue", city: "Nairobi", country: "Kenya", regNo: "BKR-2019-11472", taxNo: "P051234567J", currency: "KES", timezone: "Africa/Nairobi", status: "Active", adminName: "Mary Wanjiku", adminEmail: "mary@abcsupermarket.co.ke", createdAt: "2024-03-15" },
    { id: B2, name: "GreenLeaf Café", type: "Café", phone: "+254 720 000 222", email: "hello@greenleaf.ke", address: "Kimathi Street", city: "Nairobi", country: "Kenya", regNo: "", taxNo: "P052312564J", currency: "KES", timezone: "Africa/Nairobi", status: "Active", adminName: "John Kamau", adminEmail: "john@greenleaf.ke", createdAt: "2024-06-02" },
    { id: B3, name: "Savanna Restaurant", type: "Restaurant", phone: "+256 700 000 333", email: "info@savannarestaurant.ug", address: "Plot 14, Jinja Road", city: "Kampala", country: "Uganda", regNo: "UG-22145", taxNo: "", currency: "UGX", timezone: "Africa/Kampala", status: "Suspended", adminName: "Amina Nabulime", adminEmail: "amina@savannarestaurant.ug", createdAt: "2023-11-20" },
    { id: B4, name: "Metro Hardware", type: "Hardware", phone: "+254 733 000 444", email: "sales@metrohardware.co.ke", address: "Mombasa Road", city: "Nairobi", country: "Kenya", regNo: "BKR-2021-88741", taxNo: "P051884622X", currency: "KES", timezone: "Africa/Nairobi", status: "Active", adminName: "Peter Otieno", adminEmail: "peter@metrohardware.co.ke", createdAt: "2024-09-10" },
    { id: B5, name: "Beacon Pharmacy", type: "Pharmacy", phone: "+255 744 000 555", email: "care@beaconpharmacy.co.tz", address: "Samora Avenue", city: "Dar es Salaam", country: "Tanzania", regNo: "TZ-44321", taxNo: "", currency: "TZS", timezone: "Africa/Dar es Salaam", status: "Pending", adminName: "Grace Mwakalinga", adminEmail: "grace@beaconpharmacy.co.tz", createdAt: "2026-08-19" },
    { id: B6, name: "Prime Electronics", type: "Electronics", phone: "+254 711 000 666", email: "support@primeelectronics.co.ke", address: "River Road", city: "Nairobi", country: "Kenya", regNo: "BKR-2022-55102", taxNo: "P051223377M", currency: "KES", timezone: "Africa/Nairobi", status: "Active", adminName: "Faith Chebet", adminEmail: "faith@primeelectronics.co.ke", createdAt: "2025-01-05" }
  ],
  branches: [
    { id: "br-1", businessId: B1, name: "Main Branch", code: "ABC-001", location: "Moi Avenue, Nairobi", phone: "+254 712 000 111", email: "main@abcsupermarket.co.ke", manager: "Mary Wanjiku", status: "Active" },
    { id: "br-2", businessId: B1, name: "Westlands Branch", code: "ABC-002", location: "Westlands, Nairobi", phone: "+254 712 000 112", email: "westlands@abcsupermarket.co.ke", manager: "Peter Kamau", status: "Active" },
    { id: "br-3", businessId: B1, name: "Kisumu Branch", code: "ABC-003", location: "Oginga Odinga St, Kisumu", phone: "+254 712 000 113", email: "kisumu@abcsupermarket.co.ke", manager: "Achieng Odhiambo", status: "Active" },
    { id: "br-4", businessId: B1, name: "Mombasa Branch", code: "ABC-004", location: "Digo Road, Mombasa", phone: "+254 712 000 114", email: "mombasa@abcsupermarket.co.ke", manager: "Rehema Ali", status: "Suspended" },
    { id: "br-5", businessId: B2, name: "Kimathi Street", code: "GLF-001", location: "Kimathi Street, Nairobi", phone: "+254 720 000 222", email: "kimathi@greenleaf.ke", manager: "John Kamau", status: "Active" },
    { id: "br-6", businessId: B3, name: "Jinja Road", code: "SAV-001", location: "Jinja Road, Kampala", phone: "+256 700 000 333", email: "jinja@savannarestaurant.ug", manager: "Amina Nabulime", status: "Suspended" },
    { id: "br-7", businessId: B4, name: "Mombasa Road", code: "MTR-001", location: "Mombasa Road, Nairobi", phone: "+254 733 000 444", email: "mombasaroad@metrohardware.co.ke", manager: "Peter Otieno", status: "Active" }
  ],
  staff: [
    { id: "us-1", name: "Mary Wanjiku", email: "mary@abcsupermarket.co.ke", role: "Admin", businessId: B1, branchId: "br-1", status: "Active", lastLogin: "2026-09-02T08:12:00" },
    { id: "us-2", name: "Peter Kamau", email: "peter.k@abcsupermarket.co.ke", role: "Store Manager", businessId: B1, branchId: "br-2", status: "Active", lastLogin: "2026-09-02T07:45:00" },
    { id: "us-3", name: "Alice Nyambura", email: "alice@abcsupermarket.co.ke", role: "Cashier", businessId: B1, branchId: "br-1", status: "Active", lastLogin: "2026-09-02T06:30:00" },
    { id: "us-4", name: "Brian Mwangi", email: "brian@abcsupermarket.co.ke", role: "Cashier", businessId: B1, branchId: "br-1", status: "Active", lastLogin: "2026-09-01T18:02:00" },
    { id: "us-5", name: "Carol Achieng", email: "carol@abcsupermarket.co.ke", role: "Cashier", businessId: B1, branchId: "br-2", status: "Suspended", lastLogin: "2026-08-20T15:40:00" },
    { id: "us-6", name: "Dennis Omondi", email: "dennis@abcsupermarket.co.ke", role: "Inventory Manager", businessId: B1, branchId: "br-1", status: "Active", lastLogin: "2026-09-01T17:55:00" },
    { id: "us-7", name: "John Kamau", email: "john@greenleaf.ke", role: "Admin", businessId: B2, branchId: "br-5", status: "Active", lastLogin: "2026-09-02T09:00:00" },
    { id: "us-8", name: "Esther Wafula", email: "esther@greenleaf.ke", role: "Waiter", businessId: B2, branchId: "br-5", status: "Active", lastLogin: "2026-09-01T13:20:00" },
    { id: "us-9", name: "Peter Otieno", email: "peter@metrohardware.co.ke", role: "Admin", businessId: B4, branchId: "br-7", status: "Active", lastLogin: "2026-09-02T07:10:00" }
  ],
  products: [
    { id: "p-1", businessId: B1, branchId: "br-1", name: "Rice 5kg", sku: "ABC-RIC-005", barcode: "8964012345012", category: "Groceries", cost: 620, price: 720, stock: 340, reorderLevel: 80, unit: "Bag", tax: "16% VAT", status: "Active" },
    { id: "p-2", businessId: B1, branchId: "br-1", name: "Cooking Oil 2L", sku: "ABC-OIL-002", barcode: "8964012345029", category: "Groceries", cost: 380, price: 450, stock: 42, reorderLevel: 60, unit: "Bottle", tax: "16% VAT", status: "Active" },
    { id: "p-3", businessId: B1, branchId: "br-1", name: "Sugar 1kg", sku: "ABC-SUG-001", barcode: "8964012345036", category: "Groceries", cost: 155, price: 185, stock: 120, reorderLevel: 50, unit: "Pack", tax: "16% VAT", status: "Active" },
    { id: "p-4", businessId: B1, branchId: "br-2", name: "Bread (Sliced)", sku: "ABC-BRD-001", barcode: "8964012345043", category: "Groceries", cost: 52, price: 65, stock: 18, reorderLevel: 30, unit: "Loaf", tax: "16% VAT", status: "Active" },
    { id: "p-5", businessId: B1, branchId: "br-1", name: "Mineral Water 1L", sku: "ABC-WTR-001", barcode: "8964012345050", category: "Beverages", cost: 38, price: 50, stock: 8, reorderLevel: 40, unit: "Bottle", tax: "16% VAT", status: "Low" },
    { id: "p-6", businessId: B2, branchId: "br-5", name: "Cappuccino", sku: "GLF-CAP-001", barcode: "7164012345012", category: "Beverages", cost: 42, price: 260, stock: 0, reorderLevel: 20, unit: "Cup", tax: "Exempt", status: "Out" },
    { id: "p-7", businessId: B4, branchId: "br-7", name: "Cement (50kg)", sku: "MTR-CMT-001", barcode: "9764012345012", category: "Hardware", cost: 720, price: 850, stock: 96, reorderLevel: 40, unit: "Bag", tax: "16% VAT", status: "Active" },
    { id: "p-8", businessId: B4, branchId: "br-7", name: "Galvanised Iron Sheet", sku: "MTR-GIS-001", barcode: "9764012345029", category: "Hardware", cost: 940, price: 1120, stock: 64, reorderLevel: 30, unit: "Sheet", tax: "16% VAT", status: "Active" },
    { id: "p-9", businessId: B6, branchId: null, name: "LED TV 43\"", sku: "PRI-TV-043", barcode: "1264012345012", category: "Electronics", cost: 38500, price: 46999, stock: 24, reorderLevel: 8, unit: "Unit", tax: "16% VAT", status: "Active" }
  ],
  sales: [
    { id: "SL-1001", businessId: B1, branchId: "br-1", date: "2026-09-02T09:14:00", customer: "Walk-in Customer", cashier: "Alice Nyambura", amount: 4280, method: "Cash", status: "Completed" },
    { id: "SL-1002", businessId: B1, branchId: "br-1", date: "2026-09-02T09:42:00", customer: "J. Odhiambo", cashier: "Brian Mwangi", amount: 9150, method: "M-Pesa", status: "Completed" },
    { id: "SL-1003", businessId: B1, branchId: "br-2", date: "2026-09-02T10:05:00", customer: "Walk-in Customer", cashier: "Peter Kamau", amount: 2360, method: "Card", status: "Completed" },
    { id: "SL-1004", businessId: B1, branchId: "br-1", date: "2026-09-01T16:20:00", customer: "K. Mwende", cashier: "Alice Nyambura", amount: 14800, method: "Bank", status: "Completed" },
    { id: "SL-1005", businessId: B1, branchId: "br-1", date: "2026-09-01T17:55:00", customer: "Walk-in Customer", cashier: "Brian Mwangi", amount: 892, method: "M-Pesa", status: "Refunded" },
    { id: "SL-1006", businessId: B2, branchId: "br-5", date: "2026-09-02T08:30:00", customer: "Walk-in Customer", cashier: "Esther Wafula", amount: 1540, method: "Cash", status: "Completed" },
    { id: "SL-1007", businessId: B4, branchId: "br-7", date: "2026-09-02T11:12:00", customer: "M. Construction Co.", cashier: "Peter Otieno", amount: 61200, method: "Bank", status: "Completed" },
    { id: "SL-1008", businessId: B6, branchId: null, date: "2026-09-01T14:05:00", customer: "George Maina", cashier: "Faith Chebet", amount: 46999, method: "Card", status: "Completed" },
    { id: "SL-1009", businessId: B1, branchId: "br-1", date: "2026-09-02T12:30:00", customer: "Walk-in Customer", cashier: "Alice Nyambura", amount: 3050, method: "M-Pesa", status: "Pending" },
    { id: "SL-1010", businessId: B1, branchId: "br-3", date: "2026-09-01T15:10:00", customer: "Walk-in Customer", cashier: "Achieng Odhiambo", amount: 6670, method: "Cash", status: "Completed" }
  ],
  purchases: [
    { id: "PO-501", businessId: B1, branchId: "br-1", date: "2026-08-28", supplier: "Nakuru Grain Suppliers", items: 120, total: 86400, status: "Received" },
    { id: "PO-502", businessId: B1, branchId: "br-1", date: "2026-08-25", supplier: "East Africa Distributors", items: 200, total: 63400, status: "Received" },
    { id: "PO-503", businessId: B4, branchId: "br-7", date: "2026-08-22", supplier: "Bamburi Builders Supplies", items: 150, total: 245000, status: "Received" },
    { id: "PO-504", businessId: B1, branchId: "br-1", date: "2026-09-01", supplier: "Fresh Farms Ltd", items: 60, total: 28700, status: "Ordered" },
    { id: "PO-505", businessId: B2, branchId: "br-5", date: "2026-08-30", supplier: "Java Roasters", items: 30, total: 42100, status: "Received" }
  ],
  customers: [
    { id: "cus-1", businessId: B1, name: "James Odhiambo", phone: "+254 722 111 001", email: "j.odhiambo@example.com", totalPurchases: 42650, lastPurchase: "2026-09-02", balance: 0 },
    { id: "cus-2", businessId: B1, name: "Kendi Mwende", phone: "+254 733 111 002", email: "k.mwende@example.com", totalPurchases: 18900, lastPurchase: "2026-09-01", balance: 2400 },
    { id: "cus-3", businessId: B1, name: "George Maina", phone: "+254 700 111 003", email: "g.maina@example.com", totalPurchases: 88400, lastPurchase: "2026-08-28", balance: 0 },
    { id: "cus-4", businessId: B2, name: "Lucy Adhiambo", phone: "+254 711 111 004", email: "lucy.a@example.com", totalPurchases: 9800, lastPurchase: "2026-09-01", balance: 0 },
    { id: "cus-5", businessId: B4, name: "M. Construction Co.", phone: "+254 720 111 005", email: "accounts@mconstruction.co.ke", totalPurchases: 612000, lastPurchase: "2026-09-02", balance: 0 },
    { id: "cus-6", businessId: B6, name: "Grace Njoroge", phone: "+254 728 111 006", email: "g.njoroge@example.com", totalPurchases: 46999, lastPurchase: "2026-09-01", balance: 12500 }
  ],
  suppliers: [
    { id: "sup-1", businessId: B1, name: "Nakuru Grain Suppliers", contact: "Samuel Kiptoo", phone: "+254 733 200 001", email: "sam@nakurugrain.co.ke", address: "Nakuru CBD", totalPurchases: 164500, outstanding: 0 },
    { id: "sup-2", businessId: B1, name: "East Africa Distributors", contact: "Hassan Abdi", phone: "+254 722 200 002", email: "hassan@eadistributors.co.ke", address: "Industrial Area, Nairobi", totalPurchases: 289000, outstanding: 45000 },
    { id: "sup-3", businessId: B4, name: "Bamburi Builders Supplies", contact: "Jane Atieno", phone: "+254 712 200 003", email: "jane@bamburisupplies.co.ke", address: "Mombasa Road, Nairobi", totalPurchases: 612000, outstanding: 98000 },
    { id: "sup-4", businessId: B2, name: "Java Roasters", contact: "Brian Odongo", phone: "+254 701 200 004", email: "brian@javaroasters.co.ke", address: "Lavington, Nairobi", totalPurchases: 42100, outstanding: 0 }
  ],
  expenses: [
    { id: "ex-1", businessId: B1, branchId: "br-1", category: "Rent", description: "September premises rent", amount: 85000, date: "2026-09-01", recordedBy: "Mary Wanjiku", method: "Bank" },
    { id: "ex-2", businessId: B1, branchId: "br-1", category: "Utilities", description: "Power bill", amount: 12400, date: "2026-09-01", recordedBy: "Dennis Omondi", method: "Bank" },
    { id: "ex-3", businessId: B1, branchId: "br-1", category: "Salaries", description: "Monthly wages advance", amount: 156000, date: "2026-08-30", recordedBy: "Mary Wanjiku", method: "Bank" },
    { id: "ex-4", businessId: B1, branchId: "br-2", category: "Transport", description: "Restocking delivery", amount: 3800, date: "2026-08-29", recordedBy: "Peter Kamau", method: "Cash" },
    { id: "ex-5", businessId: B4, branchId: "br-7", category: "Utilities", description: "Security alarm service", amount: 2400 + 4500, date: "2026-08-28", recordedBy: "Peter Otieno", method: "Cash" },
    { id: "ex-6", businessId: B2, branchId: "br-5", category: "Maintenance", description: "Espresso machine service", amount: 6800, date: "2026-08-27", recordedBy: "John Kamau", method: "M-Pesa" }
  ],
  auditLogs: [
    { id: "al-1", user: "Alex Senerwa", action: "Business created", businessId: B5, date: "2026-08-19T10:12:00", ip: "IP/device available via backend" },
    { id: "al-2", user: "Alex Senerwa", action: "Business suspended", businessId: B3, date: "2026-07-30T14:33:00", ip: "IP/device available via backend" },
    { id: "al-3", user: "Mary Wanjiku", action: "Staff role changed", businessId: B1, date: "2026-08-18T09:05:00", ip: "IP/device available via backend" },
    { id: "al-4", user: "Alice Nyambura", action: "Sale completed", businessId: B1, date: "2026-09-02T09:14:00", ip: "IP/device available via backend" },
    { id: "al-5", user: "Dennis Omondi", action: "Inventory adjusted", businessId: B1, date: "2026-08-29T11:40:00", ip: "IP/device available via backend" },
    { id: "al-6", user: "John Kamau", action: "Product created", businessId: B2, date: "2026-08-21T15:22:00", ip: "IP/device available via backend" },
    { id: "al-7", user: "Brian Mwangi", action: "Refund processed", businessId: B1, date: "2026-09-01T18:01:00", ip: "IP/device available via backend" },
    { id: "al-8", user: "Peter Otieno", action: "Branch created", businessId: B4, date: "2026-08-10T08:45:00", ip: "IP/device available via backend" },
    { id: "al-9", user: "Alex Senerwa", action: "Settings changed", businessId: B1, date: "2026-07-25T12:10:00", ip: "IP/device available via backend" },
    { id: "al-10", user: "Grace Mwakalinga", action: "User added", businessId: B5, date: "2026-08-20T16:55:00", ip: "IP/device available via backend" },
    { id: "al-11", user: "Mary Wanjiku", action: "Product edited", businessId: B1, date: "2026-08-27T10:05:00", ip: "IP/device available via backend" },
    { id: "al-12", user: "Peter Kamau", action: "Sale completed", businessId: B1, date: "2026-09-02T10:05:00", ip: "IP/device available via backend" }
  ],
  refunds: [],
  settings: {
    receiptFormat: "Standard 80mm",
    receiptFooter: "Thank you for shopping with us!",
    receiptPrefix: "RF",
    receiptNumbering: "date-random",
    receiptPadding: 6,
    enableTax: true,
    enableDiscounts: true,
    paymentMethods: ["Cash", "M-Pesa", "Card"],
    dateFormat: "dd MMM yyyy"
  }
};

/* ================================================================
   API DATA LAYER — Cloudflare Worker + D1
   ----------------------------------------------------------------
   Every read/mutation below calls the RetailFlow Worker at API_BASE.
   The Worker verifies the Firebase ID token, resolves the D1 user,
   enforces role + business_id + branch_id and audits actions.
   These functions are the single data access path used by the UI.
   ================================================================ */

// BUSINESSES
async function apiGetBusinesses() {
  const data = await apiRequest("/businesses");
  db.businesses = normalizeList(data.businesses, "business");
  return db.businesses;
}
async function apiCreateBusiness(data) {
  const resp = await apiRequest("/businesses", { method: "POST", body: data });
  const b = normalizeRow(resp.business, "business");
  upsert(db.businesses, b);
  return b;
}
async function apiUpdateBusiness(id, data) {
  const resp = await apiRequest("/businesses/" + encodeURIComponent(id), { method: "PATCH", body: data });
  const b = normalizeRow(resp.business, "business");
  upsert(db.businesses, b);
  return b;
}

/* ---------------- Firebase staff provisioning ----------------
   When a staff member is added, we do three things:
     1. Create a Firebase Authentication account (email + temporary password)
        using the Identity Toolkit REST API. Calling the REST endpoint
        (instead of createUserWithEmailAndPassword) avoids signing the new
        user in inside the admin's browser and hijacking the current session.
     2. Mirror the record into the Firestore `users` collection.
     3. Share the real Firebase UID with the Worker so it is saved to D1.
   If any step fails we roll back the steps already taken.                */

async function createFirebaseAccount(email, password) {
  const res = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + encodeURIComponent(FIREBASE_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  let data = {};
  try { data = await res.json(); } catch (e) { }
  if (!res.ok || !data.localId) {
    const msg = (data && data.error && data.error.message) || "Failed to create Firebase account";
    const err = new Error(msg);
    err.code = (data && data.error && data.error.code) || String(res.status);
    throw err;
  }
  return { uid: data.localId, idToken: data.idToken, email: data.email };
}

async function deleteFirebaseAccount(idToken) {
  if (!idToken) return;
  try {
    await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=" + encodeURIComponent(FIREBASE_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      }
    );
  } catch (e) {
    console.warn("[RetailFlow] failed to roll back Firebase account:", e);
  }
}

/* Add/merge a staff record into the Firestore `users` collection. */
async function addStaffToFirestore(uid, body, createdBy) {
  const data = {
    uid,
    email: body.email || "",
    name: body.name || "",
    phone: body.phone || "",
    role: body.role || "cashier",
    businessId: body.businessId || null,
    branchId: body.branchId || null,
    status: body.status || "active",
    temporaryPassword: true,
    invitedBy: createdBy || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(doc(fsDB, "users", uid), data);
  return uid;
}

async function deleteStaffFromFirestore(uid) {
  if (!uid) return;
  try {
    await deleteDoc(doc(fsDB, "users", uid));
  } catch (e) {
    console.warn("[RetailFlow] failed to roll back Firestore user:", e);
  }
}

// STAFF & USERS
async function apiGetStaff(businessId) {
  return apiGetScopedList("/staff", "staff", "staff", "staff", { businessId });
}
async function apiCreateStaff(data) {
  const body = Object.assign({}, data);
  body.role = ROLE_VALUE[body.role] || body.role || "cashier";
  delete body.password; // never send the temporary password to the Worker / D1

  // 1) Create the Firebase Authentication account.
  let fb = null;
  if (!body.firebaseUid) {
    if (!body.email) throw new Error("Email address is required.");
    const pw = data.password;
    if (!pw) throw new Error("A temporary password is required for the new staff member.");
    fb = await createFirebaseAccount(body.email, pw);
    body.firebaseUid = fb.uid;
  }

  // 2) Mirror into the Firestore `users` collection.
  const fsUid = await addStaffToFirestore(body.firebaseUid, body, state.profile ? state.profile.email : null).catch((err) => {
    // Firestore failed → remove the auth account we just created so we never
    // leave a half-provisioned user behind.
    if (fb && fb.idToken) deleteFirebaseAccount(fb.idToken);
    console.warn("[RetailFlow] Firestore sync failed:", err);
    throw new Error("Could not sync the staff record to Firestore. " + (err && err.message ? err.message : ""));
  });

  // 3) Save the authoritative record in Cloudflare D1 via the Worker.
  try {
    const resp = await apiRequest("/staff", { method: "POST", body });
    const s = normalizeRow(resp.staff, "staff");
    upsert(db.staff, s);
    return s;
  } catch (err) {
    // D1 failed → roll back the auxiliary stores.
    await deleteStaffFromFirestore(fsUid);
    if (fb && fb.idToken) await deleteFirebaseAccount(fb.idToken);
    throw err;
  }
}
async function apiUpdateStaff(id, data) {
  const body = Object.assign({}, data);
  if (body.role) body.role = ROLE_VALUE[body.role] || body.role;
  delete body.password;
  const resp = await apiRequest("/staff/" + encodeURIComponent(id), { method: "PATCH", body });
  const s = normalizeRow(resp.staff, "staff");
  upsert(db.staff, s);
  // Keep the Firestore `users` mirror in sync (only for real Firebase UIDs).
  if (s.firebaseUid && s.firebaseUid.indexOf("pending:") !== 0) {
    try {
      await setDoc(doc(fsDB, "users", s.firebaseUid), {
        name: s.name || "",
        phone: s.phone || "",
        role: s.role,
        businessId: s.businessId || null,
        branchId: s.branchId || null,
        status: s.status || "active",
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (err) {
      console.warn("[RetailFlow] Firestore sync failed on staff update:", err);
    }
  }
  return s;
}

// BRANCHES
async function apiGetBranches(businessId) {
  return apiGetScopedList("/branches", "branches", "branch", "branches", { businessId });
}
async function apiCreateBranch(data) {
  const resp = await apiRequest("/branches", { method: "POST", body: data });
  const b = normalizeRow(resp.branch, "branch");
  upsert(db.branches, b);
  return b;
}
async function apiUpdateBranch(id, data) {
  const resp = await apiRequest("/branches/" + encodeURIComponent(id), { method: "PATCH", body: data });
  const b = normalizeRow(resp.branch, "branch");
  upsert(db.branches, b);
  return b;
}

// DASHBOARD
async function apiGetDashboardStats() {
  const data = await apiRequest("/reports/dashboard");
  const d = data.dashboard || {};
  return {
    businesses: d.businesses || 0,
    activeBusinesses: d.activeBusinesses || 0,
    staff: d.staff || 0,
    branches: d.branches || 0,
    products: d.products || 0,
    todaySales: d.todaySales || 0,
    todayTransactions: d.todayTransactions || 0,
    lowStock: d.lowStock || 0
  };
}
/* ---------------- Scope helpers ----------------
   Every business report belongs to a tenant scope:
     if role is store_manager → one branch of one business
     if role is admin          → one business
     if role is owner          → all businesses
   The frontend uses these filters to display the right data;
   the backend is the source of truth for enforcement. */
function scope() {
  const p = state.profile || {};
  const bId = p.businessId;
  const brId = p.branchId;
  const inBusiness = (row) => !row.businessId || !bId || row.businessId === bId;
  const inBranch = (row) => inBusiness(row) && (!row.branchId || !brId || row.branchId === brId);
  return {
    businessId: bId,
    branchId: brId,
    inBusiness,
    inBranch,
    filterBusiness: (list) => list.filter(inBusiness),
    filterBranch: (list) => list.filter(inBranch)
  };
}

function businessName(id) {
  const b = db.businesses.find((x) => x.id === id);
  return b ? b.name : "—";
}

function branchName(id) {
  const b = db.branches.find((x) => x.id === id);
  return b ? b.name : "—";
}

/* Owner/Admin of a business — prefers an admin record from the staff list
   (administrators are created via the Staff section), else falls back to
   the business-level adminName stored on the record. */
function businessAdmin(b) {
  if (!b) return "—";
  const s = db.staff.find((x) => x.businessId === b.id && x.role === "admin");
  return s ? s.name : (b.adminName || "—");
}

/* ---------------- Auth guard ---------------- */
/* API INTEGRATION POINT: "fetchUserProfile" will call the Cloudflare
   Worker with the Firebase ID token. The Worker looks up the user in
   D1, checks role + business/branch assignment and returns the
   profile. The frontend never trusts a role handed to it from a
   JavaScript variable — this function represents the backend call. */
async function fetchUserProfile(firebaseUser) {
  const token = await firebaseUser.getIdToken(true);
  const res = await fetch(API_BASE + "/auth/profile", {
    headers: { Authorization: "Bearer " + token }
  });
  let data = {};
  try { data = await res.json(); } catch (e) { }
  if (!res.ok || !data.success) {
    const msg = (data && (data.error || data.message)) || "Profile lookup failed";
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const u = normalizeRow(data.user || {}, "profile");
  if (u.role === "unprovisioned" || u.needsOnboarding) {
    state.needsOnboarding = true;
  }
  return {
    id: u.id,
    name: u.name || firebaseUser.displayName || u.email || "User",
    email: u.email || firebaseUser.email || "",
    role: u.role || "unprovisioned",
    businessId: u.businessId || null,
    branchId: u.branchId || null,
    needsOnboarding: !!state.needsOnboarding
  };
}

function showDenied() {
  loadingEl.classList.add("is-hidden");
  deniedEl.hidden = false;
}

function redirectToLogin() {
  if (state.redirecting) return;
  state.redirecting = true;
  window.location.assign("/login/index.html");
}

function signOutUser() {
  signOut(auth)
    .then(() => { window.location.assign("/login/index.html"); })
    .catch((err) => {
      console.warn("[RetailFlow] sign out failed:", err.code);
      showToast("error", "Error", "Could not sign you out. Please try again.");
    });
}

async function boot() {
  const p = state.profile;
  // Set user chrome
  ["sideName", "topName"].forEach((id) => { $(id).textContent = p.name; });
  ["sideAvatar", "topAvatar"].forEach((id) => { $(id).textContent = initials(p.name); });
  $("sideRole").textContent = ROLE_LABELS[p.role] || p.role;

  // Scope context
  const sc = scope();
  if (p.role === "owner") {
    sidebarContext.innerHTML =
      '<div class="scope-card"><div class="sc-label">Platform scope</div><div class="sc-value">All businesses</div></div>';
    scopeChip.hidden = true;
  } else {
    const biz = businessName(sc.businessId);
    const br = sc.branchId ? " · " + branchName(sc.branchId) : "";
    sidebarContext.innerHTML =
      '<div class="scope-card"><div class="sc-label">Access scope</div><div class="sc-value">' + esc(biz) + esc(br) + "</div></div>";
    scopeChip.hidden = false;
    scopeChip.textContent = biz + br;
  }

  try { await loadAllData(); } catch (err) {
    console.warn("[RetailFlow] failed to preload data:", err);
    showToast("error", "Sync failed", "Some data could not be loaded. Switching views will retry.");
  }
  renderSidebar();
  switchView(p.role === "owner" ? "overview" : "overview");
  loadingEl.classList.add("is-hidden");
  shellEl.hidden = false;
}

/* ---------------- Sidebar ---------------- */
function renderSidebar() {
  const role = state.profile.role;
  const items = NAV[role] || NAV.owner;
  const activeModules = sidebarModules();
  const visible = items.filter((it) => {
    if (role === "owner") return true;                       // platform owner sees everything
    if (it.key === "businesses" || it.key === "audit") return false;   // owner-level sections
    if (it.key === "refunds") return true;                   // refund approvals follow the role, not a module
    return !activeModules || activeModules.indexOf(it.key) !== -1;
  });
  const groupA = visible.slice(0, 4).map(navItemHtml).join("");
  const groupB = visible.slice(4).map(navItemHtml).join("");
  sideNav.innerHTML =
    '<div class="nav-sep">Manage</div>' + groupA +
    '<div class="nav-sep">Operations</div>' + groupB;
}

/* Enabled modules for the current scope's business (null = owner sees all). */
function sidebarModules() {
  const p = state.profile;
  if (!p || p.role === "owner") return null;
  const biz = db.businesses.find((b) => b.id === p.businessId) || db.businesses[0];
  return biz ? modulesForBusiness(biz, { hidePlanned: true }) : null;
}

function navItemHtml(item) {
  const active = state.view === item.key ? " active" : "";
  return '<button type="button" class="nav-item' + active + '" data-view="' + item.key + '">' +
    '<i class="fa-solid ' + item.icon + '" aria-hidden="true"></i><span>' + esc(item.label) + "</span></button>";
}

/* ----------------------------------------------------------------
   BUSINESS-TYPE PICKER + MODULES PREVIEW
   Shared by the Add/Edit Business modal and Settings → Business tab.
   Renders a visual 16-type picker and a live preview of the enabled
   modules. The hidden `enabledModules` input carries the per-business
   override ("" = auto-follow the type defaults).
   ---------------------------------------------------------------- */
function businessTypePicker(name, currentCode) {
  const code = normalizeTypeCode(currentCode || "retail");
  const tiles = BUSINESS_TYPE_OPTIONS.map((t) =>
    '<label class="biz-type-tile' + (t.value === code ? " is-selected" : "") + '">' +
      '<input type="radio" name="' + name + '" value="' + esc(t.value) + '"' + (t.value === code ? " checked" : "") + '>' +
      '<i class="fa-solid ' + t.icon + '" aria-hidden="true"></i>' +
      '<span>' + esc(t.label) + '</span>' +
    '</label>'
  ).join("");
  return '<div class="biz-type-grid" id="' + esc(name) + '" data-type-grid>' + tiles + '</div>' +
    '<span class="field-hint">Choose the business type — the relevant modules and features are enabled automatically.</span>';
}

function modulesPreviewHtml(biz) {
  const def = typeDef(businessTypeCode(biz));
  const stored = enabledModulesFor(biz);
  const isAuto = !Array.isArray(stored);
  const selected = isAuto ? (def.modules || []) : stored;
  const rows = SPECIAL_MODULES.map((m) => {
    const meta = MODULE_CATALOG[m] || { label: m.replace(/_/g, " "), icon: "fa-puzzle-piece", status: "planned" };
    const checked = selected.indexOf(m) !== -1;
    return '<div class="toggle-row' + (meta.status === "planned" ? " mod-planned" : "") + '">' +
      '<div><div class="t-label">' + esc(meta.label) + '</div>' +
      '<div class="t-desc">' + (meta.status === "planned" ? "Coming soon — saved now, appears when the module ships." : "Module is active for this business.") + '</div></div>' +
      '<label class="switch"><input type="checkbox" data-module="' + esc(m) + '"' + (checked ? " checked" : "") + '><span class="track"></span></label></div>';
  }).join("");
  return '<label for="bizModulesAuto">Enabled modules</label>' +
    '<div class="toggle-row"><div><div class="t-label">Auto-follow type defaults</div>' +
    '<div class="t-desc">Use the recommended modules for ' + esc(def.label) + '. Switch off to customise.</div></div>' +
    '<label class="switch"><input type="checkbox" id="bizModulesAuto"' + (isAuto ? " checked" : "") + '><span class="track"></span></label></div>' +
    '<input type="hidden" name="enabledModules" value="' + (isAuto ? "" : esc(JSON.stringify(selected))) + '">' +
    '<div class="modules-list">' + rows + '</div>' +
    '<span class="field-hint">Core modules (Products, Sales, Customers, Inventory, Purchases, Suppliers, Expenses, Reports, Staff, Branches, Settings) are always enabled.</span>';
}

function updateModulesPreview(root) {
  const grid = root.querySelector("[data-type-grid]");
  const hidden = root.querySelector('[name="enabledModules"]');
  if (!grid || !hidden) return;
  const picked = grid.querySelector("input:checked");
  const def = picked ? typeDef(picked.value) : null;
  /* Highlight the selected business-type tile (visual feedback on click). */
  grid.querySelectorAll(".biz-type-tile").forEach((tile) => {
    const rb = tile.querySelector("input");
    tile.classList.toggle("is-selected", !!(rb && rb.checked));
  });
  const auto = root.querySelector("#bizModulesAuto");
  const isAuto = !auto || auto.checked;
  let selected = [];
  if (def) {
    if (isAuto) {
      selected = def.modules || [];
    } else {
      selected = Array.prototype.slice.call(root.querySelectorAll("[data-module]:checked")).map((c) => c.dataset.module);
    }
    root.querySelectorAll("[data-module]").forEach((cb) => { cb.checked = selected.indexOf(cb.dataset.module) !== -1; });
  }
  hidden.value = isAuto ? "" : JSON.stringify(selected);
}

function wireBusinessTypeControls(root) {
  const grid = root.querySelector("[data-type-grid]");
  if (!grid) return;
  const auto = root.querySelector("#bizModulesAuto");
  grid.addEventListener("change", () => updateModulesPreview(root));
  if (auto) auto.addEventListener("change", () => updateModulesPreview(root));
  const list = root.querySelector(".modules-list");
  if (list) list.addEventListener("change", () => { if (auto && auto.checked) auto.checked = false; updateModulesPreview(root); });
  updateModulesPreview(root);
}

/* ---------------- Helpers ---------------- */
function closeNav() {                  // close mobile sidebar drawer
  if (document.body) document.body.classList.remove("nav-open");
  if (shellEl) shellEl.classList.remove("nav-open");
}

function destroyAllCharts() {          // clean up Chart.js instances from previous view
  Object.keys(state.charts || {}).forEach((id) => {
    const ch = state.charts[id];
    if (ch && typeof ch.destroy === "function") ch.destroy();
    delete state.charts[id];
  });
}

function switchView(view) {
  if (state.view !== view) {
    state.view = view;
    renderSidebar(); // refresh active state
  }
  closeNav();
  destroyAllCharts();
  setPageMeta(view);
  renderViews[view] ? renderViews[view]() : renderViews.overview();
}

function setPageMeta(view) {
  const meta = PAGE_META[view] || PAGE_META.overview;
  pageTitle.textContent = meta.title;
  pageSub.textContent = meta.sub;
}
/* ---------------- Table builders ---------------- */
/* Each column: { key, label, sortable?, render?(row) -> html, align? } */
function buildTable(columns, rows) {
  if (!rows.length) {
    return '<div class="empty-state"><i class="fa-solid fa-inbox" aria-hidden="true"></i><p>No records to display.</p></div>';
  }
  const head = columns.map((c) => {
    const sort = c.sortable ? ' class="sortable" data-sort="' + c.key + '"' : "";
    return "<th" + sort + ">" + esc(c.label) + (c.sortable ? ' <i class="fa-solid fa-sort" aria-hidden="true"></i>' : "") + "</th>";
  }).join("");
  const body = rows.map((row) => {
    const rid = (row && row.id) ? ' data-id="' + esc(row.id) + '"' : "";
    return "<tr>" + columns.map((c) => {
      let content = c.render ? c.render(row) : esc(row[c.key]);
      const align = c.align === "right" ? ' style="text-align:right;"' : "";
      if (rid && c.render) content = String(content).replace(/<button\b/g, (m) => m + rid);
      return "<td" + align + ">" + content + "</td>";
    }).join("") + "</tr>";
  }).join("");
  return '<div class="table-wrap"><table class="rf-table"><thead><tr>' + head +
    "</tr></thead><tbody>" + body + "</tbody></table></div>";
}

function paginate(list, viewKey, perPage) {
  const size = perPage || 10;
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  if (st.page == null || st.page < 1) st.page = 1;
  const pages = Math.max(1, Math.ceil(list.length / size));
  if (st.page > pages) st.page = pages;
  const start = (st.page - 1) * size;
  return { rows: list.slice(start, start + size), page: st.page, pages, total: list.length };
}

function pagerBar(viewKey, page, pages, total) {
  return '<div class="table-footer"><span>Showing <strong>' + total + "</strong> record" + (total === 1 ? "" : "s") + "</span>" +
    '<div class="pager">' +
    '<button type="button" data-pager="prev" data-viewkey="' + viewKey + '"' + (page <= 1 ? " disabled" : "") + '><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button>' +
    '<span class="pg-count">' + page + " / " + pages + "</span>" +
    '<button type="button" data-pager="next" data-viewkey="' + viewKey + '"' + (page >= pages ? " disabled" : "") + '><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button>' +
    "</div></div>";
}

function searchFilter(list, viewKey, fields) {
  const st = state.filters[viewKey] || {};
  const q = (st.search || "").toLowerCase();
  if (!q) return list;
  return list.filter((row) => fields.some((f) => String(row[f] || "").toLowerCase().includes(q)));
}

function sortRows(list, viewKey, columnsMeta) {
  const st = state.filters[viewKey] || {};
  if (!st.sortKey) return list;
  const dir = st.sortDir === "desc" ? -1 : 1;
  return list.slice().sort((a, b) => {
    const va = a[st.sortKey], vb = b[st.sortKey];
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va || "").localeCompare(String(vb || "")) * dir;
  });
}

/* ---------------- Charts ---------------- */
const CHART_COLORS = {
  emerald: "#0e9f6e",
  gold: "#f0b23e",
  blue: "#2e7dd1",
  violet: "#7c3aed",
  danger: "#e5484d",
  grid: "rgba(14,21,18,0.06)",
  muted: "rgba(14,21,18,0.4)"
};

function makeChart(canvasId, config) {
  if (typeof Chart === "undefined") return null; // graceful fallback
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  try {
    const chart = new Chart(canvas, config);
    state.charts[canvasId] = chart;
    return chart;
  } catch (e) {
    console.warn("[RetailFlow] chart failed:", e);
    return null;
  }
}

/* ---------------- Modal helpers ---------------- */
function openModal({ title, sub, wide, body, footer, onOpen }) {
  modalRoot.innerHTML =
    '<div class="modal-overlay" role="presentation">' +
    '<div class="modal-card' + (wide ? " wide" : "") + '" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
    '<div class="modal-head"><div><h3>' + esc(title) + "</h3>" + (sub ? '<p class="sub">' + esc(sub) + "</p>" : "") + "</div>" +
    '<button type="button" class="modal-close" aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>' +
    '<div class="modal-body">' + body + "</div>" +
    (footer ? '<div class="modal-foot">' + footer + "</div>" : "") +
    "</div></div>";

  const overlay = modalRoot.querySelector(".modal-overlay");
  const closeBtn = overlay.querySelector(".modal-close");
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", escKeyHandler);
  document.body.style.overflow = "hidden";
  if (onOpen) onOpen(overlay);
  return overlay;
}

function escKeyHandler(e) {
  if (e.key === "Escape" && modalRoot.innerHTML) closeModal();
}

function closeModal() {
  document.removeEventListener("keydown", escKeyHandler);
  document.body.style.overflow = "";
  modalRoot.innerHTML = "";
  renderViews[state.view]();
}

/* ---------------- Barcode Scanner Detector ---------------- */
/* Detects USB/Bluetooth barcode scanners by their rapid input pattern.
   Scanners send characters within ~10-30ms each, humans type >100ms.
   On scan end, fires onScan(barcode) with the decoded value. */
const barcodeScanner = (() => {
  let buffer = "";
  let lastKeyTime = 0;
  let timer = null;
  const SCAN_GAP_MS = 80;
  const SCAN_END_MS = 120;
  let onScanCallback = null;

  function isLikelyScanner(now, char) {
    const delta = now - lastKeyTime;
    return delta > 0 && delta < SCAN_GAP_MS && char.length === 1 && /[\w\-.\/]/.test(char);
  }

  function flush() {
    if (buffer.length >= 4 && onScanCallback) {
      onScanCallback(buffer);
    }
    buffer = "";
    timer = null;
  }

  function onKeyDown(e) {
    const now = Date.now();
    if (e.key === "Enter") {
      if (buffer.length >= 4 && onScanCallback) {
        e.preventDefault();
        e.stopPropagation();
        flush();
        return;
      }
      return;
    }
    if (e.key.length !== 1) return;
    if (isLikelyScanner(now, e.key)) {
      buffer += e.key;
      lastKeyTime = now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SCAN_END_MS);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    buffer = "";
    lastKeyTime = now;
  }

  function attach(callback) {
    onScanCallback = callback;
    document.addEventListener("keydown", onKeyDown, true);
  }

  function detach() {
    document.removeEventListener("keydown", onKeyDown, true);
    onScanCallback = null;
    buffer = "";
    if (timer) clearTimeout(timer);
  }

  return { attach, detach };
})();

/* ---------------- Barcode Scanner Modal ---------------- */
function showBarcodeScannerModal(onScan) {
  const body =
    '<div class="barcode-scan-modal">' +
    '<div class="scan-input-wrap">' +
    '<i class="fa-solid fa-barcode scan-icon"></i>' +
    '<input type="text" id="barcodeScanInput" placeholder="Scan or type barcode..." autocomplete="off" data-focus>' +
    '<button type="button" class="scan-btn" id="barcodeScanBtn"><i class="fa-solid fa-magnifying-glass"></i></button>' +
    '</div>' +
    '<p class="scan-hint"><i class="fa-solid fa-wifi"></i> Barcode scanner ready</p>' +
    '<div class="scan-result" id="scanResult"></div>' +
    '</div>';
  const footer =
    '<button type="button" class="btn btn-ghost" data-modal-cancel>Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="barcodeUseBtn" disabled><i class="fa-solid fa-check"></i> Use barcode</button>';

  openModal({ title: "Scan Barcode", sub: "Use a barcode scanner or enter manually", body, footer });
  const input = document.getElementById("barcodeScanInput");
  const result = document.getElementById("scanResult");
  const useBtn = document.getElementById("barcodeUseBtn");
  const scanBtn = document.getElementById("barcodeScanBtn");

  let scannedValue = "";

  function processBarcode(val) {
    scannedValue = val.trim();
    if (scannedValue) {
      result.innerHTML = '<div class="scan-success"><i class="fa-solid fa-check-circle"></i> Barcode: <strong>' + esc(scannedValue) + "</strong></div>";
      useBtn.disabled = false;
    } else {
      result.innerHTML = "";
      useBtn.disabled = true;
    }
  }

  barcodeScanner.attach((barcode) => {
    if (document.getElementById("barcodeScanInput")) {
      input.value = barcode;
      processBarcode(barcode);
    }
  });

  if (input) {
    input.addEventListener("input", () => processBarcode(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        processBarcode(input.value);
        if (scannedValue && onScan) {
          onScan(scannedValue);
          barcodeScanner.detach();
          closeModal();
        }
      }
    });
  }
  if (scanBtn) scanBtn.addEventListener("click", () => processBarcode(input.value));
  if (useBtn) {
    useBtn.addEventListener("click", () => {
      if (scannedValue && onScan) {
        onScan(scannedValue);
        barcodeScanner.detach();
        closeModal();
      }
    });
  }
}

/* ---------------- Barcode Print Modal ---------------- */
function showBarcodePrintModal(product) {
  const barcode = product.barcode || product.sku || product.id;
  const body =
    '<div class="barcode-print-modal">' +
    '<div class="barcode-product-info">' +
    (product.image ? '<img src="' + esc(product.image) + '" alt="' + esc(product.name) + '">' : "") +
    '<div><h4>' + esc(product.name) + "</h4>" +
    '<p>SKU: ' + esc(product.sku || "—") + " | Price: " + money(product.price) + "</p></div>" +
    '</div>' +
    '<div class="barcode-print-area">' +
    '<div class="barcode-label">' +
    '<div class="barcode-product-name">' + esc(product.name) + "</div>" +
    '<div class="barcode-visual">' + generateBarcodeSvg(barcode) + "</div>" +
    '<div class="barcode-value">' + esc(barcode) + "</div>" +
    '</div>' +
    '</div>' +
    '<div class="barcode-print-options">' +
    '<div class="form-field"><label for="barcodeQty">Copies</label>' +
    '<input type="number" id="barcodeQty" value="1" min="1" max="100"></div>' +
    '<div class="form-field"><label for="barcodeSize">Size</label>' +
    '<select id="barcodeSize"><option value="small">Small</option>' +
    '<option value="medium" selected>Medium</option>' +
    '<option value="large">Large</option></select></div>' +
    '</div>' +
    '</div>';
  const footer =
    '<button type="button" class="btn btn-ghost" data-modal-cancel>Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="printBarcodeBtn"><i class="fa-solid fa-print"></i> Print</button>';

  openModal({ title: "Print Barcode", sub: "Generate and print barcode labels", body, footer, wide: true });

  const printBtn = document.getElementById("printBarcodeBtn");
  if (printBtn) {
    printBtn.addEventListener("click", () => {
      const qty = parseInt(document.getElementById("barcodeQty")?.value) || 1;
      const size = document.getElementById("barcodeSize")?.value || "medium";
      printBarcode(product, barcode, qty, size);
    });
  }
}

/* ---------------- Barcode SVG Generation (Code 128) ---------------- */
function generateBarcodeSvg(value) {
  if (!value) return "";

  // Code 128 character patterns (B encoding)
  // Each pattern is 6 bars/spaces, values represent widths (1-4 units)
  const code128B = {
    " ": [2,1,2,2,2,2], "!": [2,2,2,1,2,2], '"': [2,2,2,2,2,1], "#": [1,2,1,2,2,3],
    "$": [1,2,1,3,2,2], "%": [1,3,1,2,2,2], "&": [1,2,2,2,1,3], "'": [1,2,2,3,1,2],
    "(": [1,3,2,2,1,2], ")": [2,2,1,2,1,3], "*": [2,2,1,3,1,2], "+": [2,3,1,2,1,2],
    ",": [1,1,2,2,3,2], "-": [1,2,2,1,3,2], ".": [1,2,2,2,3,1], "/": [1,1,3,2,2,2],
    "0": [1,2,2,1,3,2], "1": [1,2,2,2,3,1], "2": [1,1,3,2,2,2], "3": [1,2,3,1,2,2],
    "4": [1,2,3,2,2,1], "5": [1,1,2,2,3,2], "6": [1,2,2,1,3,2], "7": [1,2,2,2,3,1],
    "8": [1,1,3,2,2,2], "9": [1,2,3,1,2,2], ":": [1,2,3,2,2,1], ";": [2,1,2,1,2,3],
    "<": [2,1,2,3,2,1], "=": [2,3,2,1,2,1], ">": [2,1,1,2,2,3], "?": [2,1,2,3,2,1],
    "@": [2,3,2,1,2,1], "A": [2,1,1,2,2,3], "B": [2,1,2,3,2,1], "C": [2,3,2,1,2,1],
    "D": [2,1,1,2,2,3], "E": [2,1,2,3,2,1], "F": [2,3,2,1,2,1], "G": [2,1,1,2,2,3],
    "H": [2,1,2,3,2,1], "I": [2,3,2,1,2,1], "J": [2,1,1,2,2,3], "K": [2,1,2,3,2,1],
    "L": [2,3,2,1,2,1], "M": [2,1,1,2,2,3], "N": [2,1,2,3,2,1], "O": [2,3,2,1,2,1],
    "P": [2,1,1,2,2,3], "Q": [2,1,2,3,2,1], "R": [2,3,2,1,2,1], "S": [2,1,1,2,2,3],
    "T": [2,1,2,3,2,1], "U": [2,3,2,1,2,1], "V": [2,1,1,2,2,3], "W": [2,1,2,3,2,1],
    "X": [2,3,2,1,2,1], "Y": [2,1,1,2,2,3], "Z": [2,1,2,3,2,1], "[": [2,3,2,1,2,1],
    "\\": [2,1,1,2,2,3], "]": [2,1,2,3,2,1], "^": [2,3,2,1,2,1], "_": [2,1,1,2,2,3],
    "`": [2,1,2,3,2,1], "a": [2,3,2,1,2,1], "b": [2,1,1,2,2,3], "c": [2,1,2,3,2,1],
    "d": [2,3,2,1,2,1], "e": [2,1,1,2,2,3], "f": [2,1,2,3,2,1], "g": [2,3,2,1,2,1],
    "h": [2,1,1,2,2,3], "i": [2,1,2,3,2,1], "j": [2,3,2,1,2,1], "k": [2,1,1,2,2,3],
    "l": [2,1,2,3,2,1], "m": [2,3,2,1,2,1], "n": [2,1,1,2,2,3], "o": [2,1,2,3,2,1],
    "p": [2,3,2,1,2,1], "q": [2,1,1,2,2,3], "r": [2,1,2,3,2,1], "s": [2,3,2,1,2,1],
    "t": [2,1,1,2,2,3], "u": [2,1,2,3,2,1], "v": [2,3,2,1,2,1], "w": [2,1,1,2,2,3],
    "x": [2,1,2,3,2,1], "y": [2,3,2,1,2,1], "z": [2,1,1,2,2,3], "{": [2,1,2,3,2,1],
    "|": [2,3,2,1,2,1], "}": [2,1,1,2,2,3], "~": [2,1,2,3,2,1]
  };

  // Code 128 start code B = pattern index 104
  const startB = [2,1,2,2,2,2]; // Simplified start pattern
  // Code 128 stop pattern
  const stopPattern = [2,3,3,1,1,1,2];

  // Build barcode pattern array
  let pattern = [];

  // Start code B (index 104)
  const startBPattern = [2,1,2,2,2,2];
  pattern = pattern.concat(startBPattern);

  // Encode each character
  let checksum = 104; // Start B value
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const charPattern = code128B[char];
    if (charPattern) {
      pattern = pattern.concat(charPattern);
      // Character value for checksum (space=0, !=1, etc.)
      const charValue = char === " " ? 0 : char.charCodeAt(0) - 32;
      checksum += charValue * (i + 1);
    }
  }

  // Checksum character (mod 103)
  const checksumValue = checksum % 103;
  // Find the pattern for checksum (simplified - use space pattern offset)
  const checksumPatterns = Object.values(code128B);
  if (checksumPatterns[checksumValue]) {
    pattern = pattern.concat(checksumPatterns[checksumValue]);
  }

  // Stop pattern
  pattern = pattern.concat(stopPattern);

  // Calculate total width
  const barWidth = 2;
  const totalWidth = pattern.reduce((a, b) => a + b, 0) * barWidth;
  const height = 60;

  // Generate SVG
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + totalWidth + ' ' + height + '" preserveAspectRatio="none">';
  svg += '<rect width="100%" height="100%" fill="#fff"/>';

  let x = 0;
  let isBar = true;
  for (let i = 0; i < pattern.length; i++) {
    const w = pattern[i] * barWidth;
    if (isBar) {
      svg += '<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '" fill="#000"/>';
    }
    x += w;
    isBar = !isBar;
  }
  svg += "</svg>";
  return svg;
}

/* ---------------- Barcode Printing ---------------- */
function printBarcode(product, barcode, qty, size) {
  const sizes = { small: { w: 1, h: 0.6 }, medium: { w: 1.5, h: 0.8 }, large: { w: 2, h: 1 } };
  const s = sizes[size] || sizes.medium;

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("error", "Print blocked", "Please allow pop-ups to print barcodes.");
    return;
  }

  // Generate barcode SVG for printing
  const barcodeSvg = generateBarcodeSvg(barcode);

  let labelsHtml = "";
  for (let i = 0; i < qty; i++) {
    labelsHtml += '<div class="barcode-label-item" style="width:' + s.w + 'in;height:' + (s.h + 0.4) + 'in;">' +
      '<div class="label-name">' + esc(product.name) + "</div>" +
      '<div class="label-barcode-svg">' + barcodeSvg + "</div>" +
      '<div class="label-barcode-text">' + esc(barcode) + "</div>" +
      '<div class="label-price">' + money(product.price) + "</div></div>";
  }

  printWindow.document.write('<!DOCTYPE html><html><head><title>Barcode - ' + esc(product.name) + "</title>" +
    '<style>@page{margin:0.15in;size:auto}' +
    'body{margin:0;padding:0;font-family:Arial,sans-serif}' +
    '.barcode-label-item{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;' +
    'padding:0.1in;box-sizing:border-box;vertical-align:top}' +
    '.label-name{font-size:8px;font-weight:700;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}' +
    '.label-barcode-svg{width:100%;height:' + (size === 'small' ? 30 : size === 'medium' ? 40 : 50) + 'px}' +
    '.label-barcode-svg svg{width:100%;height:100%}' +
    '.label-barcode-text{font-family:monospace;font-size:8px;letter-spacing:1px;margin:2px 0}' +
    '.label-price{font-size:9px;font-weight:600}</style></head><body>' + labelsHtml + "</body></html>");
  printWindow.document.close();
  setTimeout(() => printWindow.print(), 300);
}

/* ---------------- Generic form modal ----------------
   fields: [{ name, label, type, required, span2, options, hint, placeholder, value }]
   sections: [{ title, icon, desc, fields }]  */
function buildFormModal({ title, sub, wide, sections, submitLabel, onSubmit, defaults }) {
  const d = defaults || {};
  const body = sections.map((sec) => {
    const fields = sec.fields.map((f) => fieldHtml(f, d[f.name])).join("");
    return '<div class="form-section"><h4><i class="fa-solid ' + (sec.icon || "fa-circle-info") + '" aria-hidden="true"></i>' +
      esc(sec.title) + (sec.desc ? ' <span class="sec-desc">— ' + esc(sec.desc) + "</span>" : "") + "</h4>" +
      '<div class="form-grid">' + fields + "</div></div>";
  }).join("");

  openModal({
    title, sub, wide,
    body,
    footer:
      '<button type="button" class="btn btn-ghost" data-modal-cancel>Cancel</button>' +
      '<button type="submit" class="btn btn-primary" data-modal-submit><span class="spinner" aria-hidden="true"></span><span>' + esc(submitLabel || "Save") + "</span></button>"
  });

  const overlay = modalRoot.querySelector(".modal-overlay");
  overlay.querySelector("[data-modal-cancel]").addEventListener("click", closeModal);

  // Wire Enter / submit
  const submitBtn = overlay.querySelector("[data-modal-submit]");
  const onSubmitBtn = () => {
    // Validate
    const errors = [];
    sections.forEach((sec) => {
      sec.fields.forEach((f) => {
        const input = overlay.querySelector('[name="' + f.name + '"]');
        const wrapper = input.closest(".form-field");
        clearFieldError(wrapper);
        if (f.required && !String(input.value || "").trim()) {
          setFieldError(wrapper, "This field is required.");
          errors.push(f.name);
        } else if (f.type === "email" && input.value && !isValidEmail(input.value)) {
          setFieldError(wrapper, "Enter a valid email address.");
          errors.push(f.name);
        } else if (f.min && String(input.value || "").length < f.min) {
          setFieldError(wrapper, "Use at least " + f.min + " characters.");
          errors.push(f.name);
        }
      });
    });
    if (errors.length) {
      const first = overlay.querySelector(".form-field.has-error input, .form-field.has-error select");
      if (first) first.focus();
      showToast("error", "Please check the form", "Some fields need your attention.");
      return;
    }

    // Collect
    const data = {};
    sections.forEach((sec) => {
      sec.fields.forEach((f) => {
        const els = overlay.querySelectorAll('[name="' + f.name + '"]');
        if (!els.length) return;
        const input = els[0];
        if (input.type === "radio") {
          // Radio groups carry the value on whichever option is checked.
          const checked = overlay.querySelector('[name="' + f.name + '"]:checked');
          data[f.name] = checked ? checked.value : "";
        } else {
          data[f.name] = input.type === "number" ? Number(input.value) : input.value.trim();
        }
      });
    });

    setButtonLoading(submitBtn, true);
    const label = submitBtn.querySelector("span");
    if (label) label.textContent = "Saving…";
    Promise.resolve(onSubmit(data))
      .then(() => { closeModal(); })
      .catch((err) => {
        console.warn("[RetailFlow] form submit failed:", err);
        const msg = (err && err.message) ? err.message : "Please try again.";
        showToast("error", "Something went wrong", msg);
        setButtonLoading(submitBtn, false);
        if (label) label.textContent = submitLabel || "Save";
      });
  };
  submitBtn.addEventListener("click", onSubmitBtn);

  const inputs = overlay.querySelectorAll("input,select,textarea");
  inputs.forEach((inp) => {
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onSubmitBtn(); } });
    inp.addEventListener("input", () => clearFieldError(inp.closest(".form-field")));
  });

  // Business-type picker + module preview wiring
  wireBusinessTypeControls(overlay);

  // Password field helpers (show/hide + generate)
  overlay.querySelectorAll(".pw-toggle, .pw-generate").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const input = btn.closest(".pw-wrap").querySelector("input");
      if (!input) return;
      if (btn.classList.contains("pw-toggle")) {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
        btn.innerHTML = show
          ? '<i class="fa-solid fa-eye-slash" aria-hidden="true"></i>'
          : '<i class="fa-solid fa-eye" aria-hidden="true"></i>';
      } else {
        input.value = randomTempPassword(14);
        clearFieldError(input.closest(".form-field"));
      }
    });
  });
  // Image upload fields — product images are stored in Cloudflare R2
  overlay.querySelectorAll(".img-field").forEach((wrap) => {
    const hidden = wrap.querySelector('input[type="hidden"]');
    const pick = wrap.querySelector(".img-pick");
    const remove = wrap.querySelector(".img-remove");
    const fileInput = wrap.querySelector(".img-input");
    const preview = wrap.querySelector(".img-preview");
    if (!hidden || !pick || !fileInput || !preview) return;
    const pickLabel = () => {
      pick.innerHTML = '<i class="fa-solid fa-upload" aria-hidden="true"></i> ' + (hidden.value ? "Replace image" : "Choose image");
    };
    const renderPreview = (url) => {
      hidden.value = url || "";
      preview.innerHTML = url
        ? '<img src="' + esc(url) + '" alt="Product image preview">'
        : '<i class="fa-regular fa-image" aria-hidden="true"></i><span>No image selected</span>';
      pickLabel();
      let rem = wrap.querySelector(".img-remove");
      if (url && !rem) {
        rem = document.createElement("button");
        rem.type = "button";
        rem.className = "img-remove";
        rem.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Remove';
        pick.insertAdjacentElement("afterend", rem);
        rem.addEventListener("click", (ev) => {
          ev.preventDefault();
          fileInput.value = "";
          renderPreview("");
        });
      } else if (!url && rem) {
        rem.remove();
      }
    };
    pick.addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
    if (remove) remove.addEventListener("click", (e) => { e.preventDefault(); fileInput.value = ""; renderPreview(""); });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      clearFieldError(wrap.closest(".form-field"));
      if (!/^image\//.test(file.type)) {
        setFieldError(wrap.closest(".form-field"), "Choose an image file (JPG, PNG, WebP…).");
        fileInput.value = "";
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setFieldError(wrap.closest(".form-field"), "Image is too large — maximum is 5 MB.");
        fileInput.value = "";
        return;
      }
      pick.disabled = true;
      pick.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Uploading…';
      try {
        const p = state.profile || {};
        const up = await apiUploadImage(file, p.businessId);
        renderPreview(up.url);
        showToast("success", "Image uploaded", "Stored in Cloudflare R2.");
      } catch (err) {
        console.warn("[RetailFlow] image upload failed:", err);
        showToast("error", "Upload failed", (err && err.message) || "Please try again.");
        fileInput.value = "";
        pickLabel();
      } finally {
        pick.disabled = false;
      }
    });
  });
  setTimeout(() => { const f = overlay.querySelector("input,select,textarea"); if (f) f.focus(); }, 60);
}

function fieldHtml(f, value) {
  const v = value != null ? value : f.value ?? "";
  const requiredMark = f.required ? ' <span class="req" aria-hidden="true">*</span>' : (f.optional ? ' <span class="opt">(optional)</span>' : "");
  const label = '<label for="' + f.name + '">' + esc(f.label) + requiredMark + "</label>";
  const hint = f.hint ? '<span class="field-hint">' + esc(f.hint) + "</span>" : "";
  const err = '<span class="field-error"><i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><span></span></span>';
  const span = f.span2 ? ' span-2' : "";
  const req = f.required ? " required" : "";

  let input = "";
  if (f.type === "select" || f.type === "multiselect") {
    const opts = (f.options || []).map((o) => {
      const ov = typeof o === "object" ? o.value : o;
      const ol = typeof o === "object" ? o.label : o;
      const sel = String(v) === String(ov) ? " selected" : "";
      return '<option value="' + esc(ov) + '"' + sel + ">" + esc(ol) + "</option>";
    }).join("");
    input = '<select id="' + f.name + '" name="' + f.name + '"' + req + ">" + opts + "</select>";
  } else if (f.type === "category") {
    // Category input with datalist - allows selecting existing or typing new
    const listId = f.name + "-list";
    const opts = (PRODUCT_CATEGORIES || []).map((c) => '<option value="' + esc(c) + '"></option>').join("");
    input = '<input type="text" id="' + f.name + '" name="' + f.name + '" value="' + esc(v) + '" ' +
      'placeholder="Select or type new category" list="' + listId + '" autocomplete="off"' + req + ">" +
      '<datalist id="' + listId + '">' + opts + "</datalist>";
  } else if (f.type === "textarea") {
    input = '<textarea id="' + f.name + '" name="' + f.name + '" placeholder="' + esc(f.placeholder || "") + '"' + req + ">" + esc(v) + "</textarea>";
  } else if (f.type === "password") {
    const revealBtn = '<button type="button" class="pw-toggle" tabindex="-1" title="Show / hide password" aria-label="Show password"><i class="fa-solid fa-eye" aria-hidden="true"></i></button>';
    const genBtn = '<button type="button" class="pw-generate" tabindex="-1" title="Generate a secure temporary password" aria-label="Generate a secure temporary password"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>';
    input = '<div class="pw-wrap"><input type="password" id="' + f.name + '" name="' + f.name + '"' +
      ' placeholder="' + esc(f.placeholder || "") + '" autocomplete="new-password" minlength="' + (f.min || 6) + '"' + req + '>' +
      genBtn + revealBtn + "</div>";
  } else if (f.type === "image") {
    input =
      '<div class="img-field" data-img-field="' + f.name + '">' +
        '<input type="hidden" id="' + f.name + '" name="' + f.name + '" value="' + esc(v) + '">' +
        '<div class="img-preview">' +
          (v ? '<img src="' + esc(v) + '" alt="">' : '<i class="fa-regular fa-image" aria-hidden="true"></i><span>No image selected</span>') +
        '</div>' +
        '<div class="img-actions">' +
          '<button type="button" class="img-pick"><i class="fa-solid fa-upload" aria-hidden="true"></i> ' + (v ? "Replace image" : "Choose image") + '</button>' +
          (v ? '<button type="button" class="img-remove"><i class="fa-solid fa-trash" aria-hidden="true"></i> Remove</button>' : "") +
          '<input type="file" class="img-input" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml" tabindex="-1" aria-hidden="true">' +
        '</div>' +
      '</div>';
  } else if (f.type === "biztype") {
    return '<div class="form-field span-2"><label for="' + f.name + '">' + esc(f.label) +
      (f.required ? ' <span class="req" aria-hidden="true">*</span>' : "") + "</label>" +
      businessTypePicker(f.name, v) + "</div>";
  } else if (f.type === "modules") {
    return '<div class="form-field span-2">' + modulesPreviewHtml(f.biz || {}) + "</div>";
  } else {
    input = '<input type="' + (f.type || "text") + '" id="' + f.name + '" name="' + f.name + '"' +
      ' placeholder="' + esc(f.placeholder || "") + '" value="' + esc(v) + '"' + req + ">";
  }
  return '<div class="form-field' + span + '">' + label + input + hint + err + "</div>";
}
/* ---------------- Shared render helpers ---------------- */
function statusBadge(status) {
  const map = {
    "Active": "badge-success", "Completed": "badge-success", "Received": "badge-success", "Paid": "badge-success",
    "Suspended": "badge-danger", "Refunded": "badge-danger", "Out": "badge-danger",
    "Pending": "badge-warning", "Low": "badge-warning", "Ordered": "badge-warning",
    "In Stock": "badge-success"
  };
  return '<span class="badge ' + (map[status] || "badge-neutral") + '">' + esc(status || "—") + "</span>";
}

function actionLinks(actions) {
  return '<div class="table-actions">' + actions.map((a) => {
    const cls = "link-action" + (a.danger ? " danger" : a.faint ? " faint" : "");
    return '<button type="button" class="' + cls + '" data-act="' + a.act + '"' + (a.id != null ? ' data-id="' + esc(a.id) + '"' : "") + (a.title ? ' title="' + esc(a.title) + '"' : "") + ">" +
      (a.icon ? '<i class="fa-solid ' + a.icon + '" aria-hidden="true"></i> ' : "") + esc(a.label) + "</button>";
  }).join("") + "</div>";
}

/* ================================================================
   VIEW: OVERVIEW
   ================================================================ */
/* Shared render helpers (stat cards, panels, mini-rows, chart theme) */
function statCard(icon, color, label, value, delta) {
  const cls = color ? " " + color : "";
  return ('<div class="stat-card">'
    + '<div class="stat-head"><div class="stat-label">' + esc(label) + '</div>'
    + '<div class="stat-icon' + cls + '"><i class="fa-solid ' + icon + '" aria-hidden="true"></i></div></div>'
    + '<div class="stat-value">' + esc(value) + '</div>')
    + (delta ? '<div class="stat-delta' + (delta.down ? " down" : "") + '"><i class="fa-solid fa-chevron-' + (delta.down ? "down" : "up") + '" aria-hidden="true"></i><span>' + esc(delta.value) + '</span><span class="muted">' + esc(delta.label) + '</span></div>' : "")
    + '</div>';
}

function panelCard(title, sub, body, icon) {
  return '<div class="panel"><div class="panel-head">'
    + '<div><h3>' + (icon ? '<i class="fa-solid ' + icon + '" aria-hidden="true"></i> ' : "") + esc(title) + '</h3>'
    + (sub ? '<p class="sub">' + esc(sub) + '</p>' : "") + '</div></div>'
    + '<div class="panel-body">' + body + '</div></div>';
}

function dailySales(days) {
  const today = new Date();
  const map = {};
  db.sales.forEach((s) => {
    if (s.status !== "Completed") return;
    const d = s.date.slice(0, 10);
    map[d] = (map[d] || 0) + s.amount;
  });
  const labels = []; const data = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    data.push(map[d.toISOString().slice(0, 10)] || 0);
  }
  return { labels, data };
}

function chartTheme() {
  return {
    plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { color: "#788278" } },
      y: { display: false }
    }
  };
}

function miniSale(s) {
  return '<div class="mini-row"><div class="chip-icon"><i class="fa-solid fa-receipt" aria-hidden="true"></i></div>'
    + '<div class="body"><div class="main">' + esc(s.customer || "Walk-in") + '</div><div class="sub">' + fmtDateTime(s.date) + ' · ' + esc(s.cashier || "—") + '</div></div>'
    + '<div class="val">' + money(s.amount) + '</div></div>';
}

function miniProduct(p) {
  const below = p.stock <= p.reorderLevel;
  return '<div class="mini-row"><div class="chip-icon' + (below ? " red" : "") + '"><i class="fa-solid fa-box" aria-hidden="true"></i></div>'
    + '<div class="body"><div class="main">' + esc(p.name) + '</div><div class="sub">' + esc(p.sku) + ' · ' + p.stock + ' left</div></div>'
    + '<div class="val">' + (below ? '<span class="badge badge-warning">Low</span>' : '<span class="badge badge-success">OK</span>') + '</div></div>';
}

/* ---------- Overview (continued) ---------- */
async function renderOverview() {
  const sc = scope();
  const isOwner = state.profile.role === "owner";
  const stats = await apiGetDashboardStats();

  const cards = [];
  if (isOwner) {
    cards.push(
      statCard("fa-briefcase", "", "Total Businesses", stats.businesses),
      statCard("fa-circle-check", "gold", "Active Businesses", stats.activeBusinesses),
      statCard("fa-user-gear", "blue", "Total Staff", stats.staff),
      statCard("fa-code-branches", "violet", "Total Branches", stats.branches)
    );
  } else {
    cards.push(
      statCard("fa-briefcase", "", "My Business", 1),
      statCard("fa-user-gear", "blue", "My Staff", stats.staff),
      statCard("fa-code-branches", "violet", "My Branches", stats.branches)
    );
  }
  cards.push(
    statCard("fa-sack-dollar", "gold", "Today's Sales", money(stats.todaySales)),
    statCard("fa-receipt", "blue", "Today's Transactions", stats.todayTransactions)
  );

  const recent = db.sales.filter((s) => sc.inBranch(s) && s.status === "Completed").slice(-6).reverse();
  const lowStock = db.products.filter((p) => sc.inBranch(p) && p.stock <= p.reorderLevel).slice(0, 5);
  const trend = dailySales(7);

  let html = '<div class="stat-grid">' + cards.join("") + '</div>';
  html += '<div class="overview-grid">';
  html += '<div class="chart-box"><canvas id="chartSalesTrend" role="img" aria-label="Sales trend"></canvas></div>';
  html += '<div class="overview-side">';
  html += panelCard("Recent transactions", "",
    '<ul class="mini-list">' + (recent.length ? recent.map(miniSale).join("") : '<p class="empty-msg">No recent sales.</p>') + '</ul>',
    "fa-receipt");
  html += panelCard("Low stock", "",
    '<ul class="mini-list">' + (lowStock.length ? lowStock.map(miniProduct).join("") : '<p class="empty-msg">All items in stock.</p>') + '</ul>',
    "fa-box");
  html += "</div></div>";
  contentEl.innerHTML = html;

  makeChart("chartSalesTrend", {
    type: "bar",
    data: { labels: trend.labels, datasets: [{
      label: "Sales", data: trend.data,
      backgroundColor: "rgba(14,159,110,0.18)", borderColor: CHART_COLORS.emerald,
      borderWidth: 1, borderRadius: 6, barThickness: 20
    }] },
    options: chartTheme()
  });
}

/* ================================================================
   API DATA LAYER (cont.) — products, inventory, sales, purchases
   ================================================================ */

// PRODUCTS
async function apiGetProducts(businessId, branchId) {
  return apiGetScopedList("/products", "products", "product", "products", { businessId, branchId });
}
async function apiCreateProduct(data) {
  const p = state.profile || {};
  const body = {
    businessId: data.businessId || p.businessId,
    branchId: data.branchId || null,
    name: data.name,
    sku: data.sku || null,
    barcode: data.barcode || null,
    category: data.category || null,
    brand: data.brand || null,
    costPrice: Number(data.cost || 0),
    sellingPrice: Number(data.price || 0),
    offerPrice: data.offerPrice ? Number(data.offerPrice) : null,
    stock: Number(data.stock || 0),
    reorderLevel: Number(data.reorderLevel || 0),
    unit: data.unit || "pcs",
    tax: data.tax ? 1 : 0,
    status: data.status || "Active",
    image: data.image || null
  };
  const resp = await apiRequest("/products", { method: "POST", body });
  const prod = normalizeRow(resp.product, "product");
  upsert(db.products, prod);
  return prod;
}
async function apiUpdateProduct(id, data) {
  const body = {
    name: data.name, sku: data.sku, barcode: data.barcode, category: data.category, brand: data.brand,
    branchId: data.branchId === undefined ? undefined : (data.branchId || null),
    costPrice: data.cost !== undefined ? Number(data.cost) : undefined,
    sellingPrice: data.price !== undefined ? Number(data.price) : undefined,
    offerPrice: data.offerPrice !== undefined ? Number(data.offerPrice) : undefined,
    stock: data.stock !== undefined ? Number(data.stock) : undefined,
    reorderLevel: data.reorderLevel !== undefined ? Number(data.reorderLevel) : undefined,
    unit: data.unit, tax: data.tax, status: data.status,
    image: data.image === undefined ? undefined : (data.image || null)
  };
  const clean = {};
  Object.keys(body).forEach((k) => { if (body[k] !== undefined) clean[k] = body[k]; });
  const resp = await apiRequest("/products/" + encodeURIComponent(id), { method: "PATCH", body: clean });
  const prod = normalizeRow(resp.product, "product");
  upsert(db.products, prod);
  return prod;
}
async function apiAdjustStock(productId, payload) {
  const body = {
    productId: productId,
    newStockLevel: Number(payload.qty || 0),
    reason: payload.reason || null
  };
  const resp = await apiRequest("/inventory/adjust", { method: "POST", body });
  const prod = normalizeRow(resp.product, "product");
  upsert(db.products, prod);
  return prod;
}

// SALES
async function apiGetSales(businessId, branchId) {
  return apiGetScopedList("/sales", "sales", "sale", "sales", { businessId, branchId });
}

// REFUND REQUESTS
/* GET /refunds returns camelCase rows already (mapRefundRequestRow in
   the Worker); normalizeList's generic camelize() covers the rest. */
async function apiGetRefunds(businessId, branchId) {
  return apiGetScopedList("/refunds", "requests", "refund", "refunds", { businessId, branchId });
}

async function apiDecideRefund(id, payload) {
  const resp = await apiRequest("/refunds/" + encodeURIComponent(id), { method: "PUT", body: payload });
  if (resp && resp.request) upsert(db.refunds, normalizeRow(resp.request, "refund"));
  return resp;
}

// PURCHASES
async function apiGetPurchases(businessId) {
  return apiGetScopedList("/purchases", "purchases", "purchase", "purchases", { businessId });
}
async function apiCreatePurchase(data) {
  const p = state.profile || {};
  const body = {
    businessId: data.businessId || p.businessId,
    branchId: data.branchId || p.branchId || null,
    supplierId: data.supplierId || null,
    supplierName: data.supplier || null,
    date: data.date || new Date().toISOString().slice(0, 10),
    items: Number(data.items || 0),
    subtotal: Number(data.subtotal || 0),
    tax: Number(data.tax || 0),
    total: Number(data.total || 0),
    status: data.status || "Ordered",
    paymentMethod: data.method || "Cash",
    notes: data.note || null
  };
  const resp = await apiRequest("/purchases", { method: "POST", body });
  const rec = normalizeRow(resp.purchase, "purchase");
  upsert(db.purchases, rec);
  return rec;
}

// CUSTOMERS
async function apiGetCustomers(businessId) {
  return apiGetScopedList("/customers", "customers", "customer", "customers", { businessId });
}
async function apiCreateCustomer(data) {
  const p = state.profile || {};
  const body = {
    businessId: data.businessId || p.businessId,
    name: data.name,
    phone: data.phone || null,
    email: data.email || null,
    address: data.address || null,
    totalPurchases: Number(data.totalPurchases || 0),
    balance: Number(data.balance || 0),
    status: data.status || "Active"
  };
  const resp = await apiRequest("/customers", { method: "POST", body });
  const c = normalizeRow(resp.customer, "customer");
  upsert(db.customers, c);
  return c;
}
async function apiUpdateCustomer(id, data) {
  const body = {
    name: data.name, phone: data.phone, email: data.email, address: data.address,
    totalPurchases: data.totalPurchases !== undefined ? Number(data.totalPurchases) : undefined,
    balance: data.balance !== undefined ? Number(data.balance) : undefined,
    status: data.status
  };
  const clean = {};
  Object.keys(body).forEach((k) => { if (body[k] !== undefined) clean[k] = body[k]; });
  const resp = await apiRequest("/customers/" + encodeURIComponent(id), { method: "PATCH", body: clean });
  const c = normalizeRow(resp.customer, "customer");
  upsert(db.customers, c);
  return c;
}

// SUPPLIERS
async function apiGetSuppliers(businessId) {
  return apiGetScopedList("/suppliers", "suppliers", "supplier", "suppliers", { businessId });
}
async function apiCreateSupplier(data) {
  const p = state.profile || {};
  const body = {
    businessId: data.businessId || p.businessId,
    name: data.name,
    contactPerson: data.contact || null,
    phone: data.phone || null,
    email: data.email || null,
    address: data.address || null,
    totalPurchases: Number(data.totalPurchases || 0),
    outstanding: Number(data.outstanding || 0),
    status: data.status || "Active"
  };
  const resp = await apiRequest("/suppliers", { method: "POST", body });
  const s = normalizeRow(resp.supplier, "supplier");
  upsert(db.suppliers, s);
  return s;
}
async function apiUpdateSupplier(id, data) {
  const body = {
    name: data.name, contactPerson: data.contact, phone: data.phone, email: data.email, address: data.address,
    totalPurchases: data.totalPurchases !== undefined ? Number(data.totalPurchases) : undefined,
    outstanding: data.outstanding !== undefined ? Number(data.outstanding) : undefined,
    status: data.status
  };
  const clean = {};
  Object.keys(body).forEach((k) => { if (body[k] !== undefined) clean[k] = body[k]; });
  const resp = await apiRequest("/suppliers/" + encodeURIComponent(id), { method: "PATCH", body: clean });
  const s = normalizeRow(resp.supplier, "supplier");
  upsert(db.suppliers, s);
  return s;
}

// EXPENSES
async function apiGetExpenses(businessId, branchId) {
  return apiGetScopedList("/expenses", "expenses", "expense", "expenses", { businessId, branchId });
}
async function apiCreateExpense(data) {
  const p = state.profile || {};
  const body = {
    businessId: data.businessId || p.businessId,
    branchId: data.branchId || p.branchId || null,
    category: data.category,
    description: data.description || null,
    amount: Number(data.amount || 0),
    date: data.date || new Date().toISOString().slice(0, 10),
    paymentMethod: data.method || "Cash",
    receipt: null
  };
  const resp = await apiRequest("/expenses", { method: "POST", body });
  const e = normalizeRow(resp.expense, "expense");
  upsert(db.expenses, e);
  return e;
}

// AUDIT LOGS
async function apiGetAuditLogs() {
  const p = state.profile || {};
  if (p.role === "owner") {
    const data = await apiRequest("/audit");
    db.auditLogs = normalizeList(data.logs, "audit");
    return db.auditLogs;
  }
  return apiGetScopedList("/audit", "logs", "audit", "auditLogs", { businessId: p.businessId });
}

// SETTINGS
async function apiGetSettings(businessId) {
  const p = state.profile || {};
  const targetId = businessId || p.businessId;
  const resp = await apiRequest("/settings?businessId=" + encodeURIComponent(targetId));
  db.settings = resp.settings || {};
  return db.settings;
}

async function apiUpdateSettings(businessId, data) {
  const body = {
    businessId: businessId,
    // Receipt settings
    receiptFormat: data.receiptFormat || "Standard 80mm",
    receiptFooter: data.receiptFooter || "",
    receiptPrefix: data.receiptPrefix || "RF",
    receiptNumbering: data.receiptNumbering || "date-random",
    receiptPadding: Number(data.receiptPadding) || 6,
    // Tax settings
    enableTax: data.enableTax !== false ? true : false,
    taxRate: typeof data.taxRate === "number" ? data.taxRate : 0,
    enableDiscounts: data.enableDiscounts !== false ? true : false,
    paymentMethods: data.paymentMethods || ["Cash", "M-Pesa", "Card"],
    // System settings
    dateFormat: data.dateFormat || "DD/MM/YYYY",
    language: data.language || "English",
    enableEmailNotifications: data.enableEmailNotifications !== false ? true : false,
    enableAudit: data.enableAudit !== false ? true : false,
    // POS toggles
    receiptPaperless: data.receiptPaperless !== false ? true : false,
    barcodeScanner: data.barcodeScanner !== false ? true : false,
    customerDisplay: data.customerDisplay !== false ? true : false,
    // User permissions
    staffReports: data.staffReports !== false ? true : false,
    staffRefunds: data.staffRefunds !== false ? true : false,
    lowStockAlerts: data.lowStockAlerts !== false ? true : false,
    multiBranch: data.multiBranch !== false ? true : false,
    // POS extras
    defaultPayment: data.defaultPayment || "Cash",
    refundPassword: data.refundPassword || ""
  };
  const resp = await apiRequest("/settings", { method: "PUT", body });
  // Update local cache
  db.settings = Object.assign(db.settings || {}, body);
  return resp.settings;
}

/* ================================================================
   M-PESA API (Cloudflare Worker + D1)
   Credentials never round-trip through the browser: GET returns
   safe metadata only, PUT sends new credentials once.
   ================================================================ */
async function apiGetMpesaConfig(businessId) {
  const p = state.profile || {};
  const target = businessId || p.businessId;
  const qs = (p.role === "owner" && target) ? "?businessId=" + encodeURIComponent(target) : "";
  const resp = await apiRequest("/mpesa/config" + qs);
  return resp.mpesa || null;
}

async function apiSaveMpesaConfig(businessId, data) {
  const body = Object.assign({}, data);
  if (state.profile && state.profile.role === "owner") body.businessId = businessId;
  const resp = await apiRequest("/mpesa/config", { method: "PUT", body });
  return resp.mpesa || null;
}

async function apiTestMpesa(businessId) {
  const body = {};
  if (state.profile && state.profile.role === "owner") body.businessId = businessId;
  const resp = await apiRequest("/mpesa/test", { method: "POST", body });
  return resp;
}

async function apiGetMpesaTransactions(businessId, params) {
  const p = state.profile || {};
  const target = businessId || p.businessId;
  const q = new URLSearchParams(params || {});
  if (p.role === "owner" && target) q.set("businessId", target);
  const qs = q.toString();
  const resp = await apiRequest("/mpesa/transactions" + (qs ? "?" + qs : ""));
  return resp;
}

async function apiGetMpesaTransaction(id) {
  const resp = await apiRequest("/mpesa/transactions/" + encodeURIComponent(id));
  return resp.transaction || null;
}

async function apiResolveMpesaTransaction(id, resolve) {
  const resp = await apiRequest("/mpesa/transactions/" + encodeURIComponent(id) + "/resolve", { method: "POST", body: { resolve } });
  return resp;
}

/* ================================================================
   SHARED LIST LAYOUT HELPERS
   ================================================================ */
/* Builds the standard list toolbar: search box(es) + filter select(s) + action buttons.
   controls: [{ placeholder } | { key, options:[{label,value}] }]
   buttons:  [{ label, act, icon?, variant?, view? }]                            */
function toolbar(viewKey, controls, buttons) {
  let left = "";
  (controls || []).forEach((c) => {
    if (c.placeholder) {
      left += '<div class="search-box"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>'
        + '<input type="search" placeholder="' + esc(c.placeholder) + '" data-search data-viewkey="' + viewKey + '" autocomplete="off"></div>';
    } else if (c.options) {
      left += '<select class="filter-select" data-filter="' + c.key + '" data-viewkey="' + viewKey + '">';
      c.options.forEach((o) => left += '<option value="' + esc(o.value) + '"' + (c.value != null && String(c.value) === String(o.value) ? " selected" : "") + '>' + esc(o.label) + '</option>');
      left += "</select>";
    }
  });
  let right = "";
  (buttons || []).forEach((b) => {
    const variant = b.variant ? "btn-" + b.variant : "btn-primary";
    right += '<button type="button" class="btn ' + variant + ' btn-sm" data-act="' + b.act + '" data-view="' + (b.view || viewKey) + '">'
      + (b.icon ? '<i class="fa-solid ' + b.icon + '" aria-hidden="true"></i> ' : "") + esc(b.label) + "</button>";
  });
  return '<div class="toolbar">' + left + right + "</div>";
}

/* Generic wrapper: every list view renders inside <section data-view="key"> so a single
   delegated click handler can read the active view + record id.              */
function listView(viewKey, controls, buttons, tableHtml, pager, extraHtml) {
  return '<section class="view" data-view="' + viewKey + '">'
    + toolbar(viewKey, controls, buttons)
    + (extraHtml || "")
    + tableHtml + (pager || "")
    + "</section>";
}

/* ================================================================
   VIEW: BUSINESSES  (platform owner scope)
   ================================================================ */
function businessColumns() {
  return [
    { key: "name", label: "Business", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(businessTypeLabel(r)) + " · " + esc(r.email) + '</div>' },
    { key: "type", label: "Type", render: (r) => esc(businessTypeLabel(r)) },
    { key: "adminName", label: "Owner/Admin", render: (r) => esc(businessAdmin(r)) },
    { key: "branches", label: "Branches", align: "right", render: (r) => db.branches.filter((b) => b.businessId === r.id).length },
    { key: "staff", label: "Staff", align: "right", render: (r) => db.staff.filter((s) => s.businessId === r.id).length },
    { key: "mpesa", label: "M-Pesa", render: (r) => mpesaBusinessCell(r.mpesa) },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "createdAt", label: "Created", sortable: true, render: (r) => fmtDate(r.createdAt) },
    { key: "x", label: "", render: (r) => actionLinks(businessActions(r)) }
  ];
}

/* Owner-level M-Pesa cell (spec §34): configuration metadata only —
   never credentials. */
function mpesaBusinessCell(m) {
  if (!m || !m.configured) {
    return '<span class="badge badge-neutral">Not configured</span>';
  }
  const cls = m.connectionStatus === "Connected" ? "badge-success"
    : m.connectionStatus === "Connection Failed" ? "badge-danger"
    : "badge-warning";
  const enabled = m.enabled ? " · STK on" : " · STK off";
  return '<div class="cell-main"><span class="badge ' + cls + '">' + esc(m.connectionStatus || "Not Tested") + "</span></div>"
    + '<div class="cell-sub">' + esc((m.environment === "production" ? "Production" : "Sandbox") + " · " + (m.shortcode || "—")) + esc(enabled) + "</div>";
}

function businessActions(r) {
  const a = [{ icon: "fa-eye", label: "View", act: "view_business" }];
  a.push({ icon: "fa-pen", label: "Edit", act: "edit_business" });
  if (r.status === "Active") a.push({ icon: "fa-pause", label: "Suspend", act: "suspend_business", danger: true });
  else if (r.status === "Suspended") a.push({ icon: "fa-play", label: "Activate", act: "activate_business" });
  else a.push({ icon: "fa-tag", label: "Mark active", act: "activate_business" });
  return a;
}

async function renderBusinesses() {
  const p = state.profile;
  const viewKey = "businesses";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetBusinesses();
  list.forEach((b) => { b.bizAdminName = businessAdmin(b); });
  if (st.type) list = list.filter((b) => businessTypeCode(b) === st.type);
  if (st.status) list = list.filter((b) => b.status === st.status);
  list = sortRows(searchFilter(list, viewKey, ["name", "typeCode", "type", "adminName", "adminEmail", "bizAdminName"]), viewKey, businessColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  contentEl.innerHTML = listView(viewKey,
    [
      { placeholder: "Search businesses…" },
      { key: "type", options: [{ label: "All types", value: "" }].concat(BUSINESS_TYPE_OPTIONS.map((t) => ({ label: t.label, value: t.value }))) },
      { key: "status", options: [{ label: "All status", value: "" }, { label: "Active", value: "Active" }, { label: "Suspended", value: "Suspended" }, { label: "Pending", value: "Pending" }] }
    ],
    [{ label: "+ Add Business", act: "add_business", icon: "fa-plus" }],
    buildTable(businessColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

/* Add / Edit Business modal — business info only (administrators are
   managed separately via the Staff section). */
function addBusinessModal(editing) {
  buildFormModal({
    title: editing ? "Edit business" : "Add business",
    sub: editing ? "Update business details." : "Register a new business on the platform.",
    wide: true,
    sections: [
      {
        title: "Business information", icon: "fa-building",
        fields: [
          { name: "type", label: "Business Type", type: "biztype", required: true },
          { name: "name", label: "Business Name", type: "text", required: true },
          { name: "phone", label: "Phone", type: "tel" },
          { name: "email", label: "Email", type: "email" },
          { name: "address", label: "Address", type: "text", span2: true },
          { name: "city", label: "City", type: "text" },
          { name: "country", label: "Country", type: "text" },
          { name: "regNo", label: "Registration Number", type: "text", optional: true },
          { name: "taxNo", label: "Tax/VAT Number", type: "text", optional: true },
          { name: "currency", label: "Currency", type: "select", options: CURRENCIES },
          { name: "timezone", label: "Timezone", type: "select", options: TIMEZONES }
        ]
      },
      {
        title: "Modules & features", icon: "fa-puzzle-piece", desc: "Customise which specialised modules this business uses.",
        fields: [
          { name: "enabledModules", label: "Enabled modules", type: "modules", biz: editing || {} }
        ]
      }
    ],
    submitLabel: editing ? "Save changes" : "Create business",
    defaults: editing || { type: "retail" },
    onSubmit: async function (data) {
      const code = normalizeTypeCode(data.type || "retail");
      let enabledModules = null;
      if (typeof data.enabledModules === "string" && data.enabledModules.trim()) {
        try { enabledModules = JSON.parse(data.enabledModules); } catch (e) { enabledModules = null; }
      }
      const payload = {
        name: data.name, typeCode: code, type: typeDef(code).label,
        phone: data.phone, email: data.email, address: data.address,
        city: data.city, country: data.country, regNo: data.regNo, taxNo: data.taxNo,
        currency: data.currency, timezone: data.timezone
      };
      if (typeof data.enabledModules === "string") payload.enabledModules = enabledModules;
      if (editing) { await apiUpdateBusiness(editing.id, payload); showToast("success", "Business updated", "Changes saved."); }
      else { await apiCreateBusiness(payload); showToast("success", "Business added", "New business registered."); }
    }
  });
}

/* Business detail modal with tabs */
function openBusinessDetail(id) {
  const b = db.businesses.find((x) => x.id === id);
  if (!b) { showToast("error", "Business not found", "Could not load this business."); return; }
  const bizStaff = db.staff.filter((s) => s.businessId === b.id);
  const bizBranches = db.branches.filter((branch) => branch.businessId === b.id);
  const bizProducts = db.products.filter((p) => p.businessId === b.id);
  const bizSales = db.sales.filter((s) => s.businessId === b.id);
  const bizCustomers = db.customers.filter((c) => c.businessId === b.id);
  const bizSuppliers = db.suppliers.filter((s) => s.businessId === b.id);

  const tabs = ["overview", "staff", "branches", "products", "sales", "customers", "suppliers"];
  const labels = { overview: "Overview", staff: "Staff", branches: "Branches", products: "Products", sales: "Sales", customers: "Customers", suppliers: "Suppliers" };
  const tabLinks = tabs.map((t) => '<button type="button" class="tab-btn' + (t === "overview" ? " active" : "") + '" data-tab="' + t + '">' + labels[t] + '</button>').join("");

  const panels =
    tabPanel("overview", true, '<div class="detail-grid">'
      + detailItem("Business name", b.name) + detailItem("Business type", businessTypeLabel(b))
      + detailItem("Phone", b.phone) + detailItem("Email", b.email)
      + detailItem("Address", b.address) + detailItem("City", b.city)
      + detailItem("Country", b.country) + detailItem("Registration #", b.regNo || "—")
      + detailItem("Tax/VAT #", b.taxNo || "—") + detailItem("Currency", b.currency)
      + detailItem("Timezone", b.timezone) + detailItem("Created", fmtDate(b.createdAt))
      + '</div>' + modulesFeaturesHtml(b) + '<div class="kpi-strip">' + kpiBox("Branches", bizBranches.length) + kpiBox("Staff", bizStaff.length) + kpiBox("Products", bizProducts.length) + kpiBox("Customers", bizCustomers.length) + '</div>')
    + tabPanel("staff", false, buildTable([
      { key: "name", label: "Staff", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.email) + '</div>' },
      { key: "role", label: "Role" }, { key: "branchId", label: "Branch", render: (r) => branchName(r.branchId) },
      { key: "status", label: "Status", render: (r) => statusBadge(r.status) }
    ], bizStaff))
    + tabPanel("branches", false, buildTable([
      { key: "name", label: "Branch", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.code) + '</div>' },
      { key: "location", label: "Location" }, { key: "manager", label: "Manager" },
      { key: "status", label: "Status", render: (r) => statusBadge(r.status) }
    ], bizBranches))
    + tabPanel("products", false, buildTable([
      { key: "name", label: "Product", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.category) + '</div>' },
      { key: "sku", label: "SKU" }, { key: "stock", label: "Stock", align: "right" },
      { key: "status", label: "Status", render: (r) => statusBadge(r.status) }
    ], bizProducts))
    + tabPanel("sales", false, buildTable([
      { key: "id", label: "Receipt", render: (r) => '<div class="cell-main">' + esc(r.id) + '</div><div class="cell-sub">' + fmtDate(r.date) + '</div>' },
      { key: "cashier", label: "Cashier" }, { key: "method", label: "Method", render: (r) => '<span class="pay-badge">' + esc(r.method) + '</span>' },
      { key: "amount", label: "Amount", align: "right", render: (r) => '<span class="cell-num">' + money(saleTotal(r)) + '</span>' },
      { key: "status", label: "Status", render: (r) => statusBadge(r.status) }
    ], bizSales))
    + tabPanel("customers", false, buildTable([
      { key: "name", label: "Customer", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.email) + '</div>' },
      { key: "phone", label: "Phone" },
      { key: "totalPurchases", label: "Total", align: "right", render: (r) => '<span class="cell-num">' + money(r.totalPurchases) + '</span>' },
      { key: "balance", label: "Balance", align: "right", render: (r) => '<span class="cell-num">' + (r.balance ? money(r.balance) : "—") + '</span>' }
    ], bizCustomers))
    + tabPanel("suppliers", false, buildTable([
      { key: "name", label: "Supplier", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.contact) + '</div>' },
      { key: "phone", label: "Phone" },
      { key: "totalPurchases", label: "Total", align: "right", render: (r) => '<span class="cell-num">' + money(r.totalPurchases) + '</span>' },
      { key: "outstanding", label: "Outstanding", align: "right", render: (r) => '<span class="cell-num">' + (r.outstanding ? money(r.outstanding) : "—") + '</span>' }
    ], bizSuppliers));

  openModal({
    title: b.name,
    sub: statusBadge(b.status),
    wide: true,
    body: '<div class="tabs">' + tabLinks + "</div>" + panels,
    footer: "",
    onOpen: (ov) => {
      ov.querySelectorAll(".tab-btn").forEach((btn) => btn.addEventListener("click", () => {
        ov.querySelectorAll(".tab-btn").forEach((t) => t.classList.toggle("active", t === btn));
        ov.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.tab === btn.dataset.tab));
      }));
      const cancel = ov.querySelector("[data-modal-cancel]");
      if (cancel) cancel.addEventListener("click", closeModal);
    }
  });
}

function tabPanel(key, active, body) {
  return '<div class="tab-panel' + (active ? " active" : "") + '" data-tab="' + key + '">'
    + '<div class="panel-body">' + body + "</div></div>";
}

function detailItem(label, value) {
  return '<div class="detail-item"><div class="d-label">' + esc(label) + '</div><div class="d-value">' + esc(value || "—") + "</div></div>";
}

/* Modules & feature badges for a business (used in the business detail modal). */
function modulesFeaturesHtml(b) {
  const mods = modulesForBusiness(b, { hidePlanned: true });
  const feats = featuresForBusiness(b);
  const modHtml = mods.map((m) => {
    const meta = MODULE_CATALOG[m];
    return meta ? '<span class="badge badge-neutral"><i class="fa-solid ' + meta.icon + '" aria-hidden="true"></i> ' + esc(meta.label) + "</span>" : "";
  }).join("");
  const featHtml = Object.keys(feats).filter((k) => feats[k]).map((k) => {
    const meta = FEATURE_META[k];
    return meta ? '<span class="badge badge-success"><i class="fa-solid ' + meta.icon + '" aria-hidden="true"></i> ' + esc(meta.label) + "</span>" : "";
  }).join("");
  return '<div class="detail-grid">' +
    '<div class="detail-item"><div class="d-label">Enabled modules</div><div class="chips">' + (modHtml || '<span class="badge badge-neutral">—</span>') + "</div></div>" +
    '<div class="detail-item"><div class="d-label">Features</div><div class="chips">' + (featHtml || '<span class="badge badge-neutral">—</span>') + "</div></div>" +
    "</div>";
}

function kpiBox(label, value) {
  return '<div class="kpi-box"><div class="k-label">' + esc(label) + '</div><div class="k-value">' + esc(value) + "</div></div>";
}

/* ================================================================
   VIEW: STAFF & USERS
   ================================================================ */
function staffColumns() {
  return [
    { key: "name", label: "Staff", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.email) + '</div>' },
    { key: "role", label: "Role", render: (r) => roleLabel(r.role) },
    { key: "businessId", label: "Business", render: (r) => businessName(r.businessId) },
    { key: "branchId", label: "Branch", render: (r) => branchName(r.branchId) },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "lastLogin", label: "Last login", render: (r) => r.lastLogin ? fmtDateTime(r.lastLogin) : "—" },
    { key: "x", label: "", render: (r) => actionLinks(staffActions(r)) }
  ];
}

function staffActions(r) {
  const me = r.email === state.profile.email;
  const a = [{ icon: "fa-eye", label: "View", act: "view_staff" }];
  a.push({ icon: "fa-pen", label: "Edit", act: "edit_staff" });
  a.push({ icon: "fa-user-gear", label: "Change role", act: "change_role_staff", faint: me });
  a.push({ icon: "fa-code-branch", label: "Assign branch", act: "assign_branch_staff" });
  if (r.status === "Active") a.push({ icon: "fa-pause", label: "Suspend", act: "suspend_staff", danger: true });
  else a.push({ icon: "fa-play", label: "Activate", act: "activate_staff" });
  a.push({ icon: "fa-key", label: "Reset access", act: "reset_staff", faint: true });
  return a;
}

async function renderStaff() {
  const p = state.profile;
  const viewKey = "staff";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  const sc = scope();
  let list = await apiGetStaff();
  if (p.role === "store_manager") list = list.filter((s) => sc.inBranch(s));
  else if (p.role === "admin") list = list.filter((s) => sc.inBusiness(s));
  if (st.role) list = list.filter((s) => s.role === st.role);
  if (st.status) list = list.filter((s) => s.status === st.status);
  list = sortRows(searchFilter(list, viewKey, ["name", "email", "role"]), viewKey, staffColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search staff…" },
     { key: "role", options: [{ label: "All roles", value: "" }].concat(Object.keys(ROLE_VALUE).map((label) => ({ label, value: ROLE_VALUE[label] }))) },
     { key: "status", options: [{ label: "All status", value: "" }, { label: "Active", value: "Active" }, { label: "Suspended", value: "Suspended" }] }],
    (state.profile.role === "owner" || state.profile.role === "admin")
      ? [{ label: "+ Add Staff", act: "add_staff", icon: "fa-plus" }]
      : [],
    buildTable(staffColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function addStaffModal(editing) {
  const p = state.profile;
  const businessOpts = (p.role === "owner")
    ? db.businesses.map((b) => ({ label: b.name, value: b.id }))
    : [{ label: businessName(p.businessId), value: p.businessId }];
  const branchOpts = (p.role === "owner")
    ? db.branches.map((br) => ({ label: br.name + " (" + businessName(br.businessId) + ")", value: br.id }))
    : db.branches.filter((br) => br.businessId === p.businessId).map((br) => ({ label: br.name, value: br.id }));
  const fields = [
    { name: "name", label: "Full Name", type: "text", required: true },
    { name: "email", label: "Email Address", type: "email", required: true },
    { name: "phone", label: "Phone", type: "tel", optional: true },
    { name: "role", label: "Role", type: "select", options: STAFF_ROLES, required: true },
    { name: "businessId", label: "Business", type: "select", options: businessOpts, required: true },
    { name: "branchId", label: "Branch", type: "select", options: [{ label: "— No branch", value: "" }].concat(branchOpts) },
    { name: "status", label: "Status", type: "select", value: "Active", options: ["Active", "Suspended"] }
  ];
  // Temporary password is only set when the account is first created — it is
  // used to create the staff member's Firebase sign-in account.
  if (!editing) {
    fields.push({
      name: "password",
      label: "Temporary Password",
      type: "password",
      required: true,
      min: 8,
      span2: true,
      placeholder: "Set a temporary password",
      hint: "Creates the staff member's Firebase sign-in account. Share it securely — they can change it after first login."
    });
  }
  buildFormModal({
    title: editing ? "Edit staff member" : "Add staff member",
    sub: editing ? "Update this person's details." : "Invite a new member of staff.",
    sections: [{
      title: "Staff details", icon: "fa-user",
      fields
    }],
    submitLabel: editing ? "Save changes" : "Add staff",
    defaults: editing || {},
    onSubmit: async function (data) {
      if (editing) { await apiUpdateStaff(editing.id, data); showToast("success", "Staff updated", "Details saved."); }
      else {
        await apiCreateStaff(data);
        showToast("success", "Staff added", "Firebase account created, Firestore + D1 records saved.");
      }
    }
  });
}

/* ================================================================
   VIEW: BRANCHES
   ================================================================ */
function branchColumns() {
  return [
    { key: "name", label: "Branch", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.code) + '</div>' },
    { key: "businessId", label: "Business", render: (r) => businessName(r.businessId) },
    { key: "location", label: "Location" },
    { key: "manager", label: "Manager" },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "x", label: "", render: (r) => actionLinks(branchActions(r)) }
  ];
}

function branchActions(r) {
  const a = [{ icon: "fa-eye", label: "View", act: "view_branch" }];
  a.push({ icon: "fa-pen", label: "Edit", act: "edit_branch" });
  if (r.status === "Active") a.push({ icon: "fa-pause", label: "Deactivate", act: "deactivate_branch", danger: true });
  else a.push({ icon: "fa-play", label: "Activate", act: "activate_branch" });
  return a;
}

async function renderBranches() {
  const p = state.profile;
  const viewKey = "branches";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetBranches();
  list = sortRows(searchFilter(list, viewKey, ["name", "code", "location", "manager"]), viewKey, branchColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  const canAdd = state.profile.role === "owner" || state.profile.role === "admin";
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search branches…" },
     { key: "status", options: [{ label: "All status", value: "" }, { label: "Active", value: "Active" }, { label: "Suspended", value: "Suspended" }] }],
    canAdd ? [{ label: "+ Add Branch", act: "add_branch", icon: "fa-plus" }] : [],
    buildTable(branchColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function addBranchModal(editing) {
  const p = state.profile;
  const bizOpts = (p.role === "owner")
    ? db.businesses.map((b) => ({ label: b.name, value: b.id }))
    : [{ label: businessName(p.businessId), value: p.businessId }];
  buildFormModal({
    title: editing ? "Edit branch" : "Add branch",
    sub: editing ? "Update branch details." : "Register a new branch for this business.",
    sections: [{
      title: "Branch information", icon: "fa-code-branch",
      fields: [
        { name: "name", label: "Branch Name", type: "text", required: true },
        { name: "code", label: "Branch Code", type: "text" },
        { name: "businessId", label: "Business", type: "select", options: bizOpts, required: true },
        { name: "location", label: "Location", type: "text", span2: true },
        { name: "phone", label: "Phone", type: "tel" },
        { name: "email", label: "Email", type: "email" },
        { name: "manager", label: "Manager", type: "text" },
        { name: "status", label: "Status", type: "select", value: "Active", options: ["Active", "Suspended"] }
      ]
    }],
    submitLabel: editing ? "Save changes" : "Create branch",
    defaults: editing || {},
    onSubmit: async function (data) {
      if (editing) { await apiUpdateBranch(editing.id, data); showToast("success", "Branch updated", "Changes saved."); }
      else { await apiCreateBranch(data); showToast("success", "Branch added", "New branch registered."); }
    }
  });
}

/* ================================================================
   VIEW: PRODUCTS
   ================================================================ */
function productColumns() {
  return [
    { key: "name", label: "Product", render: (r) => (r.image ? '<img class="prod-thumb" src="' + esc(r.image) + '" alt="" loading="lazy">' : "") + '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.category) + " · SKU: " + esc(r.sku) + '</div>' },
    { key: "sku", label: "SKU" },
    { key: "price", label: "Selling", align: "right", render: (r) => '<span class="cell-num">' + money(r.price) + '</span>' },
    { key: "stock", label: "Stock", align: "right", render: (r) => '<span class="cell-num">' + r.stock + '</span>' + (r.stock <= r.reorderLevel ? ' <span class="badge badge-warning">Low</span>' : "") },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "x", label: "", render: (r) => actionLinks(productActions(r)) }
  ];
}

function productActions(r) {
  const a = [{ icon: "fa-eye", label: "View", act: "view_product" }];
  a.push({ icon: "fa-pen", label: "Edit", act: "edit_product" });
  a.push({ icon: "fa-barcode", label: "Print barcode", act: "print_barcode" });
  a.push({ icon: "fa-box", label: "Adjust stock", act: "adjust_stock" });
  a.push({ icon: "fa-archive", label: "Archive", act: "archive_product", danger: true });
  return a;
}

async function renderProducts() {
  const p = state.profile;
  const viewKey = "products";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetProducts(p.businessId, p.branchId);
  if (st.category) list = list.filter((x) => x.category === st.category);
  list = sortRows(searchFilter(list, viewKey, ["name", "sku", "barcode", "category"]), viewKey, productColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  const canAdd = state.profile.role !== "store_manager";
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search products…" },
     { key: "category", options: [{ label: "All categories", value: "" }].concat(PRODUCT_CATEGORIES.map((c) => ({ label: c, value: c }))) }],
    canAdd ? [{ label: "+ Add Product", act: "add_product", icon: "fa-plus" }] : [],
    buildTable(productColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function addProductModal(editing) {
  // Collect unique categories from existing products
  const existingCategories = new Set(PRODUCT_CATEGORIES);
  if (state.products && state.products.length) {
    state.products.forEach((p) => {
      if (p.category) existingCategories.add(p.category);
    });
  }
  PRODUCT_CATEGORIES = Array.from(existingCategories).sort();

  buildFormModal({
    title: editing ? "Edit product" : "Add product",
    sub: editing ? "Update product details." : "Add a new item to your catalogue.",
    wide: true,
    sections: [{
      title: "Product details", icon: "fa-box",
      fields: [
        { name: "name", label: "Product Name", type: "text", required: true },
        { name: "sku", label: "SKU", type: "text" },
        { name: "barcode", label: "Barcode", type: "text" },
        { name: "category", label: "Category", type: "category", options: PRODUCT_CATEGORIES },
        { name: "cost", label: "Cost Price", type: "number" },
        { name: "price", label: "Selling Price", type: "number" },
        { name: "offerPrice", label: "Offer Price (optional)", type: "number", placeholder: "0.00", hint: "Special offer price — overrides selling price when set." },
        { name: "stock", label: "Stock Quantity", type: "number" },
        { name: "reorderLevel", label: "Reorder Level", type: "number" },
        { name: "unit", label: "Unit", type: "text" },
        { name: "tax", label: "Tax", type: "text" },
        { name: "status", label: "Status", type: "select", value: "Active", options: ["Active", "Low", "Out", "Archived"] },
        { name: "image", label: "Product Image", type: "image", span2: true, hint: "JPG, PNG or WebP — up to 5 MB, stored in Cloudflare R2." }
      ]
    }],
    submitLabel: editing ? "Save changes" : "Create product",
    defaults: editing || { status: "Active" },
    onSubmit: async function (data) {
      // Save new category if it doesn't exist
      if (data.category && !PRODUCT_CATEGORIES.includes(data.category)) {
        PRODUCT_CATEGORIES.push(data.category);
        PRODUCT_CATEGORIES.sort();
      }
      if (editing) { await apiUpdateProduct(editing.id, data); showToast("success", "Product updated", "Changes saved."); }
      else { await apiCreateProduct(data); showToast("success", "Product added", "New item added to catalogue."); }
    }
  });

  // Add scan button next to barcode field after modal renders
  setTimeout(() => {
    const barcodeInput = document.querySelector('[name="barcode"]');
    if (barcodeInput && !barcodeInput.nextElementSibling?.classList?.contains("scan-field-btn")) {
      const scanBtn = document.createElement("button");
      scanBtn.type = "button";
      scanBtn.className = "scan-field-btn";
      scanBtn.title = "Scan barcode";
      scanBtn.innerHTML = '<i class="fa-solid fa-barcode"></i>';
      scanBtn.addEventListener("click", () => {
        showBarcodeScannerModal((scannedBarcode) => {
          barcodeInput.value = scannedBarcode;
        });
      });
      barcodeInput.parentNode.style.display = "flex";
      barcodeInput.parentNode.style.alignItems = "center";
      barcodeInput.parentNode.style.gap = "8px";
      barcodeInput.style.flex = "1";
      barcodeInput.parentNode.appendChild(scanBtn);
    }
  }, 100);
}

function adjustStockModal(row) {
  buildFormModal({
    title: "Adjust stock: " + row.name,
    sub: "Current stock: " + row.stock + " " + (row.unit || ""),
    sections: [{
      title: "Stock adjustment", icon: "fa-scale-balanced",
      fields: [
        { name: "qty", label: "New quantity", type: "number", required: true },
        { name: "reason", label: "Reason", type: "text", placeholder: "e.g. Stocktake, Damaged, Returned" }
      ]
    }],
    submitLabel: "Update stock",
    onSubmit: async function (data) {
      await apiAdjustStock(row.id, { qty: data.qty, reason: data.reason });
      showToast("success", "Stock updated", "Quantity set to " + data.qty + " " + (row.unit || "") + ".");
    }
  });
}

/* ================================================================
   VIEW: INVENTORY
   ================================================================ */
async function renderInventory() {
  const p = state.profile;
  const viewKey = "inventory";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetProducts(p.businessId, p.branchId);
  if (st.status) {
    if (st.status === "low") list = list.filter((x) => x.stock <= x.reorderLevel && x.stock > 0);
    else if (st.status === "out") list = list.filter((x) => x.stock <= 0);
    else list = list.filter((x) => x.status === st.status);
  }
  list = sortRows(searchFilter(list, viewKey, ["name", "sku", "category"]), viewKey, productColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);

  const totalValue = list.reduce((s, x) => s + (x.stock * x.cost), 0);
  const low = list.filter((x) => x.stock <= x.reorderLevel && x.stock > 0).length;
  const out = list.filter((x) => x.stock <= 0).length;

  let html = '<div class="kpi-strip">'
    + kpiBox("Total SKUs", list.length)
    + kpiBox("Low stock", low)
    + kpiBox("Out of stock", out)
    + kpiBox("Inventory value", money(totalValue))
    + '</div>';
  html += listView(viewKey,
    [{ placeholder: "Search inventory…" },
     { key: "status", options: [{ label: "All", value: "" }, { label: "Low stock", value: "low" }, { label: "Out of stock", value: "out" }, { label: "Active", value: "Active" }] }],
    [{ label: "Adjust stock", act: "adjust_stock", icon: "fa-scale-balanced" }],
    buildTable(productColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
  contentEl.innerHTML = '<section class="view" data-view="' + viewKey + '">' + html + "</section>";
}

/* ================================================================
   VIEW: SALES
   ================================================================ */
/* Calculate the actual product total from items.
   r.amount = tendered amount (what the customer handed over)
   r.total  = product total (may be missing due to FIELD_MAP collision)
   Fallback: sum item.lineTotal or use r.amount if no items. */
function saleTotal(r) {
  if (r.total != null && r.total !== r.amount) return Number(r.total);
  let items = r.items;
  if (typeof items === "string") { try { items = JSON.parse(items); } catch (e) { items = []; } }
  if (Array.isArray(items) && items.length) {
    const sum = items.reduce((s, it) => s + (Number(it.total) || (Number(it.quantity) || 0) * (Number(it.price) || 0)), 0);
    if (sum > 0) return sum;
  }
  return Number(r.amount) || 0;
}

/* Calculate total offer savings from a sale's items.
   Each item may have hasOffer=true and a savings amount per unit. */
function saleSavings(r) {
  let items = r.items;
  if (typeof items === "string") { try { items = JSON.parse(items); } catch (e) { items = []; } }
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, it) => {
    if (it && it.hasOffer && it.savings > 0) return sum + (Number(it.savings) * Number(it.quantity || 1));
    return sum;
  }, 0);
}

function saleColumns() {
  return [
    { key: "id", label: "Receipt", render: (r) => '<div class="cell-main">' + esc(r.receiptNumber || r.id) + '</div><div class="cell-sub">' + fmtDate(r.date) + '</div>' },
    { key: "customer", label: "Customer", render: (r) => esc(r.customer || "Walk-in") },
    { key: "cashier", label: "Cashier", render: (r) => esc(r.cashier || "—") },
    { key: "amount", label: "Amount", align: "right", render: (r) => '<span class="cell-num">' + money(saleTotal(r)) + '</span>' },
    { key: "savings", label: "Savings", align: "right", render: (r) => { const s = saleSavings(r); return s > 0 ? '<span class="cell-savings">- ' + money(s) + '</span>' : '<span class="cell-muted">—</span>'; } },
    { key: "method", label: "Method", render: (r) => '<span class="pay-badge">' + esc(r.method) + '</span>' },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "x", label: "", render: (r) => actionLinks([{ icon: "fa-eye", label: "View", act: "view_sale" }]) }
  ];
}

async function renderSales() {
  const p = state.profile;
  const viewKey = "sales";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetSales(p.businessId, p.branchId);
  if (st.method) list = list.filter((s) => s.method === st.method);
  if (st.status) list = list.filter((s) => s.status === st.status);
  // Date filter
  if (st.dateFrom) {
    const from = new Date(st.dateFrom + 'T00:00:00');
    list = list.filter((s) => new Date(s.date || s.created_at) >= from);
  }
  if (st.dateTo) {
    const to = new Date(st.dateTo + 'T23:59:59');
    list = list.filter((s) => new Date(s.date || s.created_at) <= to);
  }
  list = sortRows(searchFilter(list, viewKey, ["id", "customer", "cashier"]), viewKey, saleColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search sales…" },
     { key: "method", options: [{ label: "All methods", value: "" }].concat(PAYMENT_METHODS.map((m) => ({ label: m, value: m }))) },
     { key: "status", options: [{ label: "All status", value: "" }, { label: "Completed", value: "Completed" }, { label: "Pending", value: "Pending" }, { label: "Refunded", value: "Refunded" }] }],
    [{ label: "Refresh", act: "refresh_sales", icon: "fa-rotate", variant: "ghost" }, { label: "Export PDF", act: "export_sales_pdf", icon: "fa-file-pdf", variant: "ghost" }],
    buildTable(saleColumns(), rows),
    pagerBar(viewKey, page, pages, total),
    // Date filter row
    '<div class="date-filter-row">'
      + '<label>From: <input type="date" class="date-filter" data-date-from data-viewkey="' + viewKey + '" value="' + (st.dateFrom || '') + '"></label>'
      + '<label>To: <input type="date" class="date-filter" data-date-to data-viewkey="' + viewKey + '" value="' + (st.dateTo || '') + '"></label>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-clear-dates data-viewkey="' + viewKey + '">Clear dates</button>'
      + '</div>'
  );
}

function viewSaleModal(r) {
  // Parse items — may be an array or a JSON string from the database
  let items = r.items;
  if (typeof items === "string") { try { items = JSON.parse(items); } catch (e) { items = []; } }
  if (!Array.isArray(items)) items = [];

  const n2 = (v) => (Number(v) || 0).toFixed(2);

  // Build items table
  let itemsHtml = "";
  if (items.length) {
    const hasAnyOffer = items.some((it) => it && it.hasOffer && it.savings > 0);
    const itemRows = items.map((it) => {
      const itemSavings = (it && it.hasOffer && it.savings > 0) ? n2(it.savings * (it.quantity || 1)) : '';
      return '<tr><td>' + esc(it.name || it.productId || "Item") + '</td>'
        + '<td class="right">' + (Number(it.quantity) || 0) + '</td>'
        + '<td class="right">' + n2(it.price) + '</td>'
        + '<td class="right"><strong>' + n2(it.total) + '</strong></td>'
        + (hasAnyOffer ? '<td class="right savings">' + (itemSavings ? '- ' + itemSavings : '—') + '</td>' : '')
        + '</tr>';
    }).join("");
    itemsHtml = '<div class="sale-items">'
      + '<div class="sale-items-title">Items sold</div>'
      + '<table class="sale-items-table"><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th>'
      + (hasAnyOffer ? '<th class="right">Savings</th>' : '') + '</tr></thead>'
      + '<tbody>' + itemRows + '</tbody></table></div>';
  } else {
    itemsHtml = '<div class="sale-items"><div class="sale-items-title">Items sold</div><p class="muted">No item details available.</p></div>';
  }

  const savings = saleSavings(r);
  const body = '<div class="detail-grid">'
    + detailItem("Receipt #", r.receiptNumber || r.id) + detailItem("Date", fmtDateTime(r.date))
    + detailItem("Customer", r.customer) + detailItem("Cashier", r.cashier)
    + detailItem("Branch", branchName(r.branchId))
    + detailItem("Payment", r.method) + detailItem("Status", r.status)
    + (r.method === "M-Pesa" ? detailItem("M-Pesa Receipt", r.mpesaReceiptNumber || "—") : "")
    + (savings > 0 ? detailItem("Offer Savings", "- " + money(savings)) : "")
    + '</div>' + itemsHtml;
  openModal({
    title: "Transaction " + r.id,
    sub: money(saleTotal(r)),
    wide: true,
    body,
    footer: '<button type="button" class="btn btn-ghost btn-sm" data-modal-cancel><i class="fa-solid fa-xmark" aria-hidden="true"></i> Close</button>',
    onOpen: (ov) => ov.querySelector("[data-modal-cancel]").addEventListener("click", closeModal)
  });
}

/* ================================================================
   VIEW: REFUNDS
   Refund requests submitted from the POS terminals. Pending
   requests can be approved or rejected by owner / admin /
   store_manager — approval is enforced server-side (PUT /refunds/:id).
   ================================================================ */
function refundColumns() {
  return [
    { key: "receiptNumber", label: "Receipt #", render: (r) => '<div class="cell-main">' + esc(r.receiptNumber || r.saleId || r.id) + '</div><div class="cell-sub">' + fmtDateTime(r.createdAt) + '</div>' },
    { key: "requestedByName", label: "Requested by", render: (r) => esc(r.requestedByName || "—") },
    { key: "amount", label: "Amount", align: "right", render: (r) => '<span class="cell-num">' + money(r.amount) + '</span>' },
    { key: "reason", label: "Reason", render: (r) => '<div class="cell-sub" style="max-width:260px;white-space:normal;">' + esc(r.reason || "—") + '</div>' },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "decidedByName", label: "Decided by", render: (r) => r.decidedByName ? esc(r.decidedByName) + '<div class="cell-sub">' + fmtDateTime(r.decidedAt) + '</div>' : "—" },
    { key: "x", label: "", render: (r) => {
        const actions = [{ icon: "fa-eye", label: "View", act: "view_refund", title: "View products on this sale" }];
        if (r.status === "Pending") {
          actions.push({ icon: "fa-check", label: "Approve", act: "approve_refund", title: "Approve refund" });
          actions.push({ icon: "fa-xmark", label: "Reject", act: "reject_refund", danger: true, title: "Reject refund" });
        }
        return actionLinks(actions);
      } }
  ];
}

/* ================================================================
   VIEW: M-PESA TRANSACTIONS  (spec §29/§30)
   Today's stats + a filterable ledger of STK Push payments.
   Owner / Business Admin / Store Manager only (Worker enforces).
   ================================================================ */
const MPESA_DATE_PRESETS = [
  { label: "Today", value: "today" },
  { label: "Yesterday", value: "yesterday" },
  { label: "This Week", value: "week" },
  { label: "This Month", value: "month" },
  { label: "Custom Date", value: "custom" }
];

function mpesaDateRange(preset) {
  const now = new Date();
  const iso = (d) => d.toISOString();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
  if (preset === "yesterday") {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    return { from: iso(startOfDay(y)), to: iso(endOfDay(y)) };
  }
  if (preset === "week") {
    const w = new Date(now); w.setDate(w.getDate() - 7);
    return { from: iso(startOfDay(w)), to: iso(endOfDay(now)) };
  }
  if (preset === "month") {
    const m = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: iso(startOfDay(m)), to: iso(endOfDay(now)) };
  }
  return { from: iso(startOfDay(now)), to: iso(endOfDay(now)) };
}

function mpesaDatePresetParams(st) {
  if (st.preset === "custom" && st.customFrom && st.customTo) {
    return { from: st.customFrom, to: st.customTo };
  }
  return mpesaDateRange(st.preset || "today");
}

function mpesaStatusBadge(status) {
  const map = {
    Completed: "badge-success", Pending: "badge-warning", Underpaid: "badge-warning",
    Failed: "badge-danger", Cancelled: "badge-neutral"
  };
  return '<span class="badge ' + (map[status] || "badge-neutral") + '">' + esc(status || "—") + "</span>";
}

async function renderMpesa() {
  const p = state.profile;
  const viewKey = "mpesa";
  const st = state.filters[viewKey] = state.filters[viewKey] || { preset: "today" };
  if (!st.preset) st.preset = "today";

  const canConfig = p.role === "owner" || p.role === "admin";
  let config = null;
  let data = { transactions: [], stats: null };
  try { config = await apiGetMpesaConfig(p.businessId); } catch (e) { config = null; }
  try { data = await apiGetMpesaTransactions(p.businessId, mpesaDatePresetParams(st)); } catch (e) { /* empty */ }

  let list = data.transactions || [];
  if (st.status) list = list.filter((t) => t.status === st.status);
  if (st.branch) list = list.filter((t) => String(t.branch_id || "") === String(st.branch));
  list = sortRows(searchFilter(list, viewKey, ["phone_number", "mpesa_receipt_number", "checkout_request_id", "sale_receipt_number"]), viewKey, mpesaColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);

  const stats = data.stats || { todaySales: 0, transactions: 0, successful: 0, pending: 0, failed: 0 };
  const kpis = '<div class="kpi-strip">'
    + kpiBox("Today's M-Pesa Sales", money(stats.todaySales))
    + kpiBox("Transactions", String(stats.transactions))
    + kpiBox("Successful", String(stats.successful))
    + kpiBox("Pending", String(stats.pending))
    + kpiBox("Failed", String(stats.failed))
    + "</div>";

  const configCard = canConfig
    ? '<div class="panel mpesa-config-card"><div class="panel-head"><h3><i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i> M-Pesa Account</h3>'
      + '<div class="panel-head-actions"><button type="button" class="btn btn-primary btn-sm" data-act="mpesa_configure"><i class="fa-solid fa-gear" aria-hidden="true"></i> Configure</button></div></div>'
      + mpesaSummaryHtml(config)
      + "</div>"
    : "";

  contentEl.innerHTML = '<section class="view" data-view="' + viewKey + '">'
    + kpis
    + configCard
    + listView(viewKey,
      [{ placeholder: "Search phone, receipt…" },
       { key: "preset", options: MPESA_DATE_PRESETS.map((x) => ({ label: x.label, value: x.value })), value: st.preset },
       { key: "status", options: [{ label: "All statuses", value: "" }, { label: "Completed", value: "Completed" }, { label: "Pending", value: "Pending" }, { label: "Underpaid", value: "Underpaid" }, { label: "Failed", value: "Failed" }, { label: "Cancelled", value: "Cancelled" }], value: st.status },
       { key: "branch", options: [{ label: "All branches", value: "" }].concat(db.branches.filter((b) => !p.businessId || b.businessId === p.businessId).map((b) => ({ label: b.name, value: b.id }))), value: st.branch }],
      [],
      buildTable(mpesaColumns(), rows),
      pagerBar(viewKey, page, pages, total))
    + "</section>";
}

function mpesaColumns() {
  return [
    { key: "createdAt", label: "Date", sortable: true, render: (r) => '<div class="cell-main">' + fmtDate(r.created_at) + '</div><div class="cell-sub">' + fmtTime(r.created_at) + "</div>" },
    { key: "sale_receipt_number", label: "Receipt", render: (r) => esc(r.sale_receipt_number || "—") },
    { key: "phone_number", label: "Phone", render: (r) => '<span class="mono">' + esc(maskPhoneLocal(r.phone_number)) + "</span>" },
    { key: "amount", label: "Amount", align: "right", render: (r) => money(r.amount) },
    { key: "mpesa_receipt_number", label: "M-Pesa Receipt", render: (r) => '<span class="mono">' + esc(r.mpesa_receipt_number || "—") + "</span>" },
    { key: "cashier_name", label: "Cashier", render: (r) => esc(r.cashier_name || "—") },
    { key: "branch_name", label: "Branch", render: (r) => esc(r.branch_name || "—") },
    { key: "status", label: "Status", render: (r) => mpesaStatusBadge(r.status) },
    { key: "x", label: "", render: (r) => actionLinks(mpesaActions(r)) }
  ];
}

function mpesaActions(r) {
  const a = [{ icon: "fa-eye", label: "View", act: "view_mpesa" }];
  if ((state.profile.role === "owner" || state.profile.role === "admin") && (r.status === "Underpaid" || r.status === "Pending")) {
    a.push({ icon: "fa-check", label: "Complete", act: "mpesa_resolve_complete" });
    a.push({ icon: "fa-ban", label: "Void", act: "mpesa_resolve_void", danger: true });
  }
  return a;
}

/* M-Pesa summary card body (safe metadata only — never credentials). */
function mpesaSummaryHtml(cfg) {
  if (!cfg || !cfg.configured) {
    return '<p class="sec-desc">M-Pesa is not configured for this business yet. Configure Daraja to accept M-Pesa payments at the POS.</p>';
  }
  const passkeyCell = cfg.passkeyConfigured
    ? "Configured ✓"
    : "Not set — required for STK Push";
  return '<div class="detail-grid">'
    + detailItem("Status", cfg.connectionStatus || "Not Tested")
    + detailItem("Environment", cfg.environment || "sandbox")
    + detailItem(cfg.shortcodeType === "PayBill" ? "PayBill" : "Till Number", cfg.shortcode)
    + detailItem("STK Push", cfg.enabled ? "Enabled" : "Disabled")
    + detailItem("Passkey", passkeyCell)
    + "</div>";
}

/* Local phone mask for the admin console (mirrors the Worker helper). */
function maskPhoneLocal(input) {
  const s = String(input == null ? "" : input);
  if (s.length < 6) return "••••";
  return s.slice(0, -3).replace(/[0-9]/g, "•") + s.slice(-3);
}

async function renderRefunds() {
  const p = state.profile;
  const viewKey = "refunds";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetRefunds(p.businessId, p.branchId);
  if (st.status) list = list.filter((r) => r.status === st.status);
  list = sortRows(searchFilter(list, viewKey, ["id", "receiptNumber", "requestedByName", "reason"]), viewKey, refundColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search refunds…" },
     { key: "status", options: [{ label: "All status", value: "" }, { label: "Pending", value: "Pending" }, { label: "Approved", value: "Approved" }, { label: "Rejected", value: "Rejected" }] }],
    [{ label: "Refresh", act: "refresh_refunds", icon: "fa-rotate" }],
    buildTable(refundColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function decideRefundModal(row, decision) {
  const approved = decision === "Approved";
  openModal({
    title: approved ? "Approve refund" : "Reject refund",
    sub: row.receiptNumber || row.saleId || row.id,
    body: '<div class="detail-grid">'
      + detailItem("Amount", money(row.amount))
      + detailItem("Requested by", row.requestedByName || "—")
      + detailItem("Reason", row.reason || "—")
      + "</div>"
      + (approved
        ? '<p class="muted">Approving marks the sale as Refunded, restores product stock and adjusts the customer&rsquo;s purchase totals.</p>'
        : '<p class="muted">Rejecting keeps the sale as-is; the cashier can submit a new request if needed.</p>')
      + '<div class="form-field"><label for="refundDecisionNotes">Notes (optional)</label>'
      + '<textarea id="refundDecisionNotes" rows="2" maxlength="500" placeholder="Add context for the audit trail…"></textarea></div>',
    footer: '<button type="button" class="btn btn-ghost btn-sm" data-modal-cancel><i class="fa-solid fa-xmark" aria-hidden="true"></i> Cancel</button>'
      + '<button type="button" class="btn btn-primary btn-sm" id="refundDecisionOk"><i class="fa-solid ' + (approved ? "fa-check" : "fa-xmark") + '" aria-hidden="true"></i> '
      + (approved ? "Approve refund" : "Reject refund") + "</button>",
    onOpen: (ov) => {
      const cancel = ov.querySelector("[data-modal-cancel]");
      if (cancel) cancel.addEventListener("click", closeModal);
      const ok = ov.querySelector("#refundDecisionOk");
      if (ok) ok.addEventListener("click", async () => {
        ok.disabled = true;
        try {
          await apiDecideRefund(row.id, {
            decision: decision,
            notes: ((ov.querySelector("#refundDecisionNotes") || {}).value || "").trim()
          });
          closeModal();
          showToast("success", approved ? "Refund approved" : "Refund rejected",
            approved ? "The sale is now marked as refunded and stock has been restored." : "The cashier can submit a new request if needed.");
          if (renderViews[state.view]) renderViews[state.view]();
        } catch (e) {
          ok.disabled = false;
          showToast("error", "Update failed", e && e.message ? e.message : "Please try again.");
        }
      });
    }
  });
}

/* View modal — refund details + the products on the refunded sale.
   The refund request doesn't store line items; they come from the
   original sale row (already loaded into db.sales by GET /sales). */
function viewRefundModal(row) {
  const sale = (db.sales || []).find((s) => s.id === row.saleId) || null;

  let items = [];
  if (sale) {
    items = sale.items;
    if (typeof items === "string") { try { items = JSON.parse(items); } catch (e) { items = []; } }
    if (!Array.isArray(items)) items = [];
  }

  const n2 = (v) => (Number(v) || 0).toFixed(2);

  let itemsHtml;
  if (items.length) {
    const itemRows = items.map((it) =>
      "<tr><td>" + esc(it.name || it.productId || "Item") + "</td>"
      + '<td class="right">' + (Number(it.quantity) || 0) + "</td>"
      + '<td class="right">' + n2(it.price) + "</td>"
      + '<td class="right"><strong>' + n2(it.total) + "</strong></td></tr>"
    ).join("");
    itemsHtml = '<div class="sale-items">'
      + '<div class="sale-items-title">Products on the sale</div>'
      + '<table class="sale-items-table"><thead><tr><th>Product</th><th class="right">Qty</th><th class="right">Price</th><th class="right">Total</th></tr></thead>'
      + "<tbody>" + itemRows + "</tbody></table></div>";
  } else {
    itemsHtml = '<div class="sale-items"><div class="sale-items-title">Products on the sale</div><p class="muted">No item details available for this sale.</p></div>';
  }

  const body = '<div class="detail-grid">'
    + detailItem("Receipt #", row.receiptNumber || row.saleId)
    + detailItem("Refund amount", money(row.amount))
    + detailItem("Requested by", row.requestedByName || "—")
    + detailItem("Requested", fmtDateTime(row.createdAt))
    + detailItem("Reason", row.reason || "—")
    + detailItem("Status", row.status || "Pending")
    + (row.decidedByName ? detailItem("Decided by", row.decidedByName + (row.decidedAt ? " · " + fmtDateTime(row.decidedAt) : "")) : "")
    + (row.decisionNotes ? detailItem("Decision notes", row.decisionNotes) : "")
    + "</div>" + itemsHtml;

  const pending = row.status === "Pending";
  const footer = '<button type="button" class="btn btn-ghost btn-sm" data-modal-cancel><i class="fa-solid fa-xmark" aria-hidden="true"></i> Close</button>'
    + (pending
      ? '<button type="button" class="btn btn-danger btn-sm" id="refundViewReject"><i class="fa-solid fa-xmark" aria-hidden="true"></i> Reject</button>'
        + '<button type="button" class="btn btn-primary btn-sm" id="refundViewApprove"><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button>'
      : "");

  openModal({
    title: "Refund request",
    sub: row.receiptNumber || row.saleId || row.id,
    wide: true,
    body,
    footer,
    onOpen: (ov) => {
      const cancel = ov.querySelector("[data-modal-cancel]");
      if (cancel) cancel.addEventListener("click", closeModal);
      const rj = ov.querySelector("#refundViewReject");
      if (rj) rj.addEventListener("click", () => { closeModal(); decideRefundModal(row, "Rejected"); });
      const ap = ov.querySelector("#refundViewApprove");
      if (ap) ap.addEventListener("click", () => { closeModal(); decideRefundModal(row, "Approved"); });
    }
  });
}

/* ================================================================
   VIEW: PURCHASES
   ================================================================ */
function purchaseColumns() {
  return [
    { key: "id", label: "PO #", render: (r) => '<div class="cell-main">' + esc(r.id) + '</div><div class="cell-sub">' + fmtDate(r.date) + '</div>' },
    { key: "supplier", label: "Supplier" },
    { key: "items", label: "Items", align: "right", render: (r) => '<span class="cell-num">' + purchaseItemCount(r) + '</span>' },
    { key: "total", label: "Total", align: "right", render: (r) => '<span class="cell-num">' + money(r.total) + '</span>' },
    { key: "status", label: "Status", render: (r) => statusBadge(r.status) },
    { key: "x", label: "", render: (r) => actionLinks([{ icon: "fa-eye", label: "View", act: "view_purchase" }]) }
  ];
}

async function renderPurchases() {
  const p = state.profile;
  const viewKey = "purchases";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetPurchases(p.businessId);
  if (st.status) list = list.filter((x) => x.status === st.status);
  list = sortRows(searchFilter(list, viewKey, ["id", "supplier"]), viewKey, purchaseColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  const canAdd = state.profile.role !== "store_manager";
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search purchases…" },
     { key: "status", options: [{ label: "All status", value: "" }, { label: "Ordered", value: "Ordered" }, { label: "Received", value: "Received" }, { label: "Pending", value: "Pending" }] }],
    canAdd ? [{ label: "+ Add Purchase", act: "add_purchase", icon: "fa-plus" }] : [],
    buildTable(purchaseColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function purchaseItemCount(r) {
  if (Array.isArray(r.items)) return r.items.length;
  if (typeof r.items === "string" && r.items) {
    try { const a = JSON.parse(r.items); return Array.isArray(a) ? a.length : r.items; } catch (e) { return r.items; }
  }
  return Number(r.items || 0);
}

function addPurchaseModal() {
  buildFormModal({
    title: "Add purchase order",
    sub: "Record a new purchase from a supplier.",
    wide: true,
    sections: [
      {
        title: "Supplier", icon: "fa-truck",
        fields: [
          { name: "supplier", label: "Supplier name", type: "text", required: true },
          { name: "date", label: "Date", type: "date" },
          { name: "status", label: "Status", type: "select", value: "Ordered", options: ["Ordered", "Pending", "Received"] }
        ]
      },
      {
        title: "Order details", icon: "fa-cart-shopping",
        fields: [
          { name: "items", label: "Number of items", type: "number" },
          { name: "total", label: "Total amount", type: "number" },
          { name: "note", label: "Note", type: "textarea", optional: true }
        ]
      }
    ],
    submitLabel: "Create purchase order",
    onSubmit: async function (data) {
      await apiCreatePurchase(data);
      showToast("success", "Purchase order created", "Stock movement recorded.");
    }
  });
}

/* ================================================================
   VIEW: CUSTOMERS
   ================================================================ */
function customerColumns() {
  return [
    { key: "name", label: "Customer", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.email || r.phone) + '</div>' },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "totalPurchases", label: "Total purchases", align: "right", render: (r) => '<span class="cell-num">' + money(r.totalPurchases) + '</span>' },
    { key: "lastPurchase", label: "Last purchase", render: (r) => fmtDate(r.lastPurchase) },
    { key: "balance", label: "Balance", align: "right", render: (r) => '<span class="cell-num">' + (r.balance ? money(r.balance) : "—") + '</span>' },
    { key: "x", label: "", render: (r) => actionLinks(r.balance ? [{ icon: "fa-pen", label: "Edit", act: "edit_customer" }] : [{ icon: "fa-plus", label: "Sale", act: "quick_sale" }, { icon: "fa-pen", label: "Edit", act: "edit_customer" }]) }
  ];
}

async function renderCustomers() {
  const p = state.profile;
  const viewKey = "customers";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetCustomers(p.businessId);
  list = sortRows(searchFilter(list, viewKey, ["name", "email", "phone"]), viewKey, customerColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search customers…" }],
    [{ label: "+ Add Customer", act: "add_customer", icon: "fa-plus" }],
    buildTable(customerColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function addCustomerModal(editing, businessId) {
  buildFormModal({
    title: editing ? "Edit customer" : "Add customer",
    sub: editing ? "Update customer details." : "Add a new customer to your address book.",
    sections: [{
      title: "Customer details", icon: "fa-user",
      fields: [
        { name: "name", label: "Full Name", type: "text", required: true },
        { name: "phone", label: "Phone", type: "tel" },
        { name: "email", label: "Email", type: "email" },
        { name: "totalPurchases", label: "Total purchases", type: "number", value: 0 },
        { name: "lastPurchase", label: "Last purchase", type: "date" },
        { name: "balance", label: "Outstanding balance", type: "number", value: 0 }
      ]
    }],
    submitLabel: editing ? "Save changes" : "Add customer",
    defaults: editing || { businessId: businessId || state.profile.businessId, totalPurchases: 0, balance: 0 },
    onSubmit: async function (data) {
      if (editing) { await apiUpdateCustomer(editing.id, data); showToast("success", "Customer updated", "Details saved."); }
      else { await apiCreateCustomer(data); showToast("success", "Customer added", editing ? "" : "Contact recorded."); }
    }
  });
}

/* ================================================================
   VIEW: SUPPLIERS
   ================================================================ */
function supplierColumns() {
  return [
    { key: "name", label: "Supplier", render: (r) => '<div class="cell-main">' + esc(r.name) + '</div><div class="cell-sub">' + esc(r.contact) + '</div>' },
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "totalPurchases", label: "Total purchases", align: "right", render: (r) => '<span class="cell-num">' + money(r.totalPurchases) + '</span>' },
    { key: "outstanding", label: "Outstanding", align: "right", render: (r) => '<span class="cell-num">' + (r.outstanding ? money(r.outstanding) : "—") + '</span>' },
    { key: "x", label: "", render: (r) => actionLinks([{ icon: "fa-pen", label: "Edit", act: "edit_supplier" }]) }
  ];
}

async function renderSuppliers() {
  const p = state.profile;
  const viewKey = "suppliers";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetSuppliers(p.businessId);
  list = sortRows(searchFilter(list, viewKey, ["name", "contact", "email"]), viewKey, supplierColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  contentEl.innerHTML = listView(viewKey,
    [{ placeholder: "Search suppliers…" }],
    [{ label: "+ Add Supplier", act: "add_supplier", icon: "fa-plus" }],
    buildTable(supplierColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

function addSupplierModal(editing) {
  buildFormModal({
    title: editing ? "Edit supplier" : "Add supplier",
    sub: editing ? "Update supplier details." : "Add a new supplier.",
    sections: [{
      title: "Supplier details", icon: "fa-truck",
      fields: [
        { name: "name", label: "Company name", type: "text", required: true },
        { name: "contact", label: "Contact person", type: "text" },
        { name: "phone", label: "Phone", type: "tel" },
        { name: "email", label: "Email", type: "email" },
        { name: "address", label: "Address", type: "text", span2: true },
        { name: "totalPurchases", label: "Total purchases", type: "number", value: 0 },
        { name: "outstanding", label: "Outstanding balance", type: "number", value: 0 }
      ]
    }],
    submitLabel: editing ? "Save changes" : "Add supplier",
    defaults: editing || { businessId: state.profile.businessId, totalPurchases: 0, outstanding: 0 },
    onSubmit: async function (data) {
      if (editing) { await apiUpdateSupplier(editing.id, data); showToast("success", "Supplier updated", "Details saved."); }
      else { await apiCreateSupplier(data); showToast("success", "Supplier added", editing ? "" : "Supplier recorded."); }
    }
  });
}

/* ================================================================
   VIEW: EXPENSES
   ================================================================ */
function expenseColumns() {
  return [
    { key: "category", label: "Category", render: (r) => '<div class="cell-main">' + esc(r.category) + '</div>' },
    { key: "description", label: "Description" },
    { key: "date", label: "Date", render: (r) => fmtDate(r.date) },
    { key: "recordedBy", label: "Recorded by" },
    { key: "amount", label: "Amount", align: "right", render: (r) => '<span class="cell-num">' + money(r.amount) + '</span>' },
    { key: "method", label: "Method", render: (r) => '<span class="pay-badge">' + esc(r.method) + '</span>' }
  ];
}

async function renderExpenses() {
  const p = state.profile;
  const viewKey = "expenses";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  let list = await apiGetExpenses(p.businessId, p.branchId);
  if (st.category) list = list.filter((e) => e.category === st.category);
  list = sortRows(searchFilter(list, viewKey, ["category", "description", "recordedBy"]), viewKey, expenseColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  const totalExp = list.reduce((s, x) => s + x.amount, 0);
  let html = '<div class="kpi-strip">' + kpiBox("Expenses (period)", total) + kpiBox("Total amount", money(totalExp)) + '</div>';
  // wait — kpiBox("Expenses (period)", total) uses raw count; fix below
  contentEl.innerHTML = '<section class="view" data-view="' + viewKey + '">' + html + listView(viewKey,
    [{ placeholder: "Search expenses…" },
     { key: "category", options: [{ label: "All categories", value: "" }].concat(db.expenses.reduce((set, e) => { if (!set.includes(e.category)) set.push(e.category); return set; }, []).map((c) => ({ label: c, value: c }))) }],
    [{ label: "+ Record expense", act: "add_expense", icon: "fa-plus" }],
    buildTable(expenseColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  ) + "</section>";
}

function addExpenseModal() {
  buildFormModal({
    title: "Record expense",
    sub: "Log a business expense with receipt details.",
    sections: [{
      title: "Expense details", icon: "fa-money-bill-wave",
      fields: [
        { name: "category", label: "Category", type: "select", required: true, options: ["Rent", "Utilities", "Payroll", "Supplies", "Maintenance", "Transport", "Marketing", "Insurance", "Taxes", "Other"] },
        { name: "description", label: "Description", type: "text", span2: true },
        { name: "amount", label: "Amount", type: "number", required: true },
        { name: "date", label: "Date", type: "date" },
        { name: "recordedBy", label: "Recorded by", type: "text" },
        { name: "method", label: "Payment method", type: "select", options: PAYMENT_METHODS }
      ]
    }],
    submitLabel: "Record expense",
    defaults: { businessId: state.profile.businessId, branchId: state.profile.branchId, amount: 0, recordedBy: state.profile.name },
    onSubmit: async function (data) {
      await apiCreateExpense(data);
      showToast("success", "Expense recorded", "Expense saved to your records.");
    }
  });
}

/* ================================================================
   VIEW: REPORTS
   ================================================================ */
async function renderReports() {
  const p = state.profile;
  const viewKey = "reports";
  state.filters[viewKey] = state.filters[viewKey] || {};
  const sales = (await apiGetSales(p.businessId, p.branchId)).filter((s) => s.status === "Completed");
  const expenses = await apiGetExpenses(p.businessId, p.branchId);
  const revenue = sales.reduce((s, x) => s + saleTotal(x), 0);
  const totalExp = expenses.reduce((s, x) => s + x.amount, 0);
  const gross = revenue - totalExp;
  const trend = dailySales(7);
  const sc = scope();
  const custs = db.customers.filter((c) => sc.inBusiness(c)).slice().sort((a, b) => b.totalPurchases - a.totalPurchases).slice(0, 5);
  const prods = db.products.filter((pr) => sc.inBusiness(pr)).slice().sort((a, b) => (b.stock * b.price) - (a.stock * a.price)).slice(0, 5);

  let html = '<div class="kpi-strip">'
    + kpiBox("Revenue", money(revenue))
    + kpiBox("Expenses", money(totalExp))
    + kpiBox("Gross profit", money(gross))
    + kpiBox("Transactions", sales.length)
    + "</div>";
  html += '<div class="report-grid">';
  html += '<div class="chart-card"><h3>Sales trend (last 7 days)</h3><p class="sub">Completed transactions by day.</p><div class="chart-box"><canvas id="chartReportSales" role="img" aria-label="Sales trend"></canvas></div></div>';
  html += '<div class="report-side">';
  html += panelCard("Top customers", "", miniListRows(custs.map(miniCustomer), "No customer data yet."), "fa-user");
  html += panelCard("Top products by value", "", miniListRows(prods.map(miniProductValue), "No product data yet."), "fa-box");
  html += "</div></div>";
  contentEl.innerHTML = '<section class="view" data-view="' + viewKey + '">' + html + "</section>";

  makeChart("chartReportSales", {
    type: "line",
    data: { labels: trend.labels, datasets: [{
      label: "Sales", data: trend.data,
      borderColor: CHART_COLORS.emerald, backgroundColor: "rgba(14,159,110,0.12)",
      tension: 0.35, fill: true, borderWidth: 2, pointRadius: 3, pointBackgroundColor: "#fff", pointBorderWidth: 2
    }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: "index", intersect: false } },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: "#788278" } },
        y: { grid: { color: "rgba(14,21,18,0.06)" }, border: { display: false }, ticks: { display: false } }
      }
    }
  });
}

function miniListRows(items, empty) {
  return '<ul class="mini-list">' + (items.length ? items.join("") : '<p class="empty-msg">' + esc(empty) + "</p>") + "</ul>";
}

function miniCustomer(c) {
  return '<div class="mini-row"><div class="chip-icon blue"><i class="fa-solid fa-user" aria-hidden="true"></i></div>'
    + '<div class="body"><div class="main">' + esc(c.name) + '</div><div class="cell-sub">' + esc(c.email || c.phone) + '</div></div>'
    + '<div class="val">' + money(c.totalPurchases) + "</div></div>";
}

function miniProductValue(p) {
  const val = p.stock * p.price;
  return '<div class="mini-row"><div class="chip-icon"><i class="fa-solid fa-box" aria-hidden="true"></i></div>'
    + '<div class="body"><div class="main">' + esc(p.name) + '</div><div class="cell-sub">' + esc(p.sku) + " · KES " + p.price + '</div></div>'
    + '<div class="val">' + money(val) + "</div></div>";
}

/* ================================================================
   VIEW: AUDIT LOGS
   ================================================================ */
/* ---------------- Audit log details ----------------
   The Worker stores a JSON `details` blob with every audit entry
   (receipt numbers, sale/product/staff IDs, amounts, stock levels…).
   These helpers surface it: a readable summary in the table, the
   full reference list in the View modal, and a column in the PDF. */

const AUDIT_ACTION_LABELS = {
  business_created: "Business created", business_updated: "Business updated",
  branch_created: "Branch created", branch_updated: "Branch updated",
  staff_created: "Staff member added", staff_updated: "Staff updated",
  product_created: "Product created", product_updated: "Product updated",
  inventory_adjusted: "Inventory adjusted",
  sale_created: "Sale completed",
  purchase_created: "Purchase recorded",
  customer_created: "Customer added", customer_updated: "Customer updated",
  supplier_created: "Supplier added", supplier_updated: "Supplier updated",
  expense_created: "Expense recorded", expense_updated: "Expense updated",
  settings_updated: "Settings changed",
  file_uploaded: "File uploaded",
  mpesa_config_created: "M-Pesa configured",
  mpesa_config_updated: "M-Pesa credentials replaced",
  mpesa_connection_tested: "M-Pesa connection tested",
  mpesa_enabled: "M-Pesa enabled",
  mpesa_disabled: "M-Pesa disabled",
  mpesa_stkpush_initiated: "M-Pesa STK Push initiated",
  mpesa_payment_completed: "M-Pesa payment completed",
  mpesa_payment_failed: "M-Pesa payment failed"
};

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action || "—";
}

const AUDIT_DETAIL_LABELS = {
  saleId: "Sale ID", receiptNumber: "Receipt #", total: "Total", paymentMethod: "Payment method",
  refundRequestId: "Refund request ID", amount: "Amount", notes: "Notes",
  productId: "Product ID", previousStock: "Stock before", newStock: "Stock after", quantity: "Quantity",
  purchaseId: "Purchase ID", customerId: "Customer ID", supplierId: "Supplier ID",
  expenseId: "Expense ID", staffId: "Staff ID", branchId: "Branch ID",
  email: "Email", role: "Role", status: "Status",
  objectKey: "File key", contentType: "Content type", sizeBytes: "Size (bytes)",
  type: "Type", typeCode: "Type code",
  transactionId: "M-Pesa transaction ID", checkoutRequestId: "Checkout request ID",
  paidAmount: "Paid amount", paid: "Paid", expected: "Expected",
  mpesaReceiptNumber: "M-Pesa receipt #", resultCode: "Result code",
  environment: "Environment", shortcode: "Shortcode", shortcodeType: "Shortcode type",
  credentialsReplaced: "Credentials replaced",
  reason: "Reason", resultDescription: "Result description",
  phone: "Customer phone (masked)"
};

function parseAuditDetails(r) {
  if (!r) return null;
  if (r.details && typeof r.details === "object") return r.details;
  if (typeof r.details === "string" && r.details) {
    try {
      const d = JSON.parse(r.details);
      return (d && typeof d === "object") ? d : null;
    } catch (e) { return null; }
  }
  return null;
}

/* One-line, human-readable summary for the table cell + PDF. */
function auditDetailsParts(r, plain) {
  const d = parseAuditDetails(r);
  if (!d) return [];
  return Object.keys(d).map((k) => {
    const v = d[k];
    if (v == null || v === "") return null;
    const label = AUDIT_DETAIL_LABELS[k] || k;
    const value = (typeof v === "object") ? JSON.stringify(v) : String(v);
    return plain
      ? label + ": " + value
      : esc(label) + ': <span class="mono">' + esc(value) + "</span>";
  }).filter(Boolean);
}

function auditDetailsSummary(r) {
  const parts = auditDetailsParts(r, false);
  if (!parts.length) return '<span class="cell-sub">—</span>';
  return '<div class="cell-sub" style="max-width:320px;white-space:normal;">' + parts.join(" &middot; ") + "</div>";
}

function auditDetailsPlainText(r) {
  const parts = auditDetailsParts(r, true);
  return parts.length ? parts.join(" | ") : "—";
}

function viewAuditModal(r) {
  const d = parseAuditDetails(r);
  let detailsHtml;
  if (d && Object.keys(d).length) {
    const rows = Object.keys(d).map((k) => {
      const v = d[k];
      return "<tr><td>" + esc(AUDIT_DETAIL_LABELS[k] || k) + '</td><td class="mono">' +
        esc((typeof v === "object") ? JSON.stringify(v) : String(v == null ? "—" : v)) + "</td></tr>";
    }).join("");
    detailsHtml = '<div class="sale-items"><div class="sale-items-title">Reference IDs &amp; details</div>'
      + '<table class="sale-items-table"><tbody>' + rows + "</tbody></table></div>";
  } else {
    detailsHtml = '<div class="sale-items"><div class="sale-items-title">Reference IDs &amp; details</div><p class="muted">No extra details were recorded for this event.</p></div>';
  }
  const body = '<div class="detail-grid">'
    + detailItem("Event", auditActionLabel(r.action))
    + detailItem("Action code", r.action || "—")
    + detailItem("User", r.user || "—")
    + detailItem("Email", r.userEmail || "—")
    + detailItem("Business", businessName(r.businessId))
    + detailItem("Branch", branchName(r.branchId))
    + detailItem("When", fmtDateTime(r.date))
    + detailItem("IP / Device", r.ip || "—")
    + "</div>" + detailsHtml;
  openModal({
    title: "Audit record",
    sub: r.id,
    wide: true,
    body,
    footer: '<button type="button" class="btn btn-ghost btn-sm" data-modal-cancel><i class="fa-solid fa-xmark" aria-hidden="true"></i> Close</button>',
    onOpen: (ov) => { const c = ov.querySelector("[data-modal-cancel]"); if (c) c.addEventListener("click", closeModal); }
  });
}

function auditColumns() {
  return [
    { key: "date", label: "Date", sortable: true, render: (r) => '<div class="cell-main">' + fmtDateTime(r.date) + '</div><div class="cell-sub mono">' + esc(r.id || "") + '</div>' },
    { key: "user", label: "User", render: (r) => '<div class="cell-main">' + esc(r.user || "—") + '</div><div class="cell-sub">' + esc(r.userEmail || "") + "</div>" },
    { key: "action", label: "Event", render: (r) => '<div class="cell-main">' + esc(auditActionLabel(r.action)) + '</div><div class="cell-sub mono">' + esc(r.action || "") + "</div>" },
    { key: "businessId", label: "Business", render: (r) => businessName(r.businessId) },
    { key: "details", label: "What happened / Reference", render: (r) => auditDetailsSummary(r) },
    { key: "ip", label: "IP / Device" },
    { key: "x", label: "", render: () => actionLinks([{ icon: "fa-eye", label: "View", act: "view_audit", title: "View full audit record" }]) }
  ];
}

async function renderAuditLogs() {
  const viewKey = "audit";
  const st = state.filters[viewKey] = state.filters[viewKey] || {};
  const p = state.profile;
  let list = await apiGetAuditLogs();
  // Owner sees platform-wide; admin/manager scope to their business where possible
  if (p.role !== "owner") list = list.filter((l) => !l.businessId || l.businessId === p.businessId);
  else if (st.business) list = list.filter((l) => l.businessId === st.business);
  list = filterAuditRange(list, st.range);
  // Keep the filtered list for the PDF export (search/sort/paging are UI-only)
  state.auditFiltered = list;
  list = sortRows(searchFilter(list, viewKey, ["user", "action", "ip", "details"]), viewKey, auditColumns());
  const { rows, page, pages, total } = paginate(list, viewKey);
  const controls = [{ placeholder: "Search audit logs…" }];
  if (p.role === "owner") {
    controls.push({ key: "business", value: st.business, options: [{ label: "All businesses", value: "" }].concat(db.businesses.map((b) => ({ label: b.name, value: b.id }))) });
  }
  controls.push({ key: "range", value: st.range, options: [
    { label: "All time", value: "" }, { label: "Today", value: "today" },
    { label: "Last 7 days", value: "7d" }, { label: "Last 30 days", value: "30d" },
    { label: "Last 90 days", value: "90d" }
  ] });
  contentEl.innerHTML = listView(viewKey,
    controls,
    [{ label: "Download PDF", act: "audit_pdf", icon: "fa-file-pdf" }],
    buildTable(auditColumns(), rows),
    pagerBar(viewKey, page, pages, total)
  );
}

/* Time-range filter for audit logs: "" = all time. */
function filterAuditRange(list, range) {
  if (!range) return list;
  const now = new Date();
  let start = null;
  if (range === "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (range === "7d") start = new Date(now.getTime() - 7 * 86400000);
  else if (range === "30d") start = new Date(now.getTime() - 30 * 86400000);
  else if (range === "90d") start = new Date(now.getTime() - 90 * 86400000);
  if (!start) return list;
  return list.filter((l) => { const d = new Date(l.date); return !isNaN(d) && d >= start; });
}

/* Designed PDF export of the filtered audit log list.
   Uses jsPDF + autotable (CDN); degrades gracefully if offline. */
function downloadAuditPdf() {
  const JsPdfCtor = window.jspdf && window.jspdf.jsPDF;
  if (!JsPdfCtor) {
    showToast("error", "PDF unavailable", "The PDF library did not load. Check your internet connection and reload the page.");
    return;
  }
  const list = state.auditFiltered || [];
  if (!list.length) {
    showToast("info", "Nothing to export", "No audit records match the current filters.");
    return;
  }
  const doc = new JsPdfCtor({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const emerald = [14, 159, 110];
  const ink = [24, 34, 29];
  const st = state.filters.audit || {};
  const rangeLabels = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" };
  const scopeLabel = state.profile.role === "owner"
    ? (st.business ? "Business: " + businessName(st.business) : "All businesses")
    : (businessName(state.profile.businessId) || "My business");

  // Header band
  doc.setFillColor(emerald[0], emerald[1], emerald[2]);
  doc.rect(0, 0, pageW, 64, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("RetailFlow — Audit Logs", 40, 30);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(scopeLabel + "    Period: " + (rangeLabels[st.range] || "All time") + "    Generated: " + new Date().toLocaleString(), 40, 48);

  // Summary line
  doc.setTextColor(ink[0], ink[1], ink[2]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("Records: " + list.length, 40, 86);

  const table = {
    startY: 98,
    head: [["Date & Time", "User", "Event", "Business", "What happened / Reference", "IP / Device"]],
    body: list.map((l) => [
      fmtDateTime(l.date),
      l.user || "—",
      auditActionLabel(l.action) + (l.action && l.action !== auditActionLabel(l.action) ? " (" + l.action + ")" : ""),
      businessName(l.businessId) || "—",
      auditDetailsPlainText(l),
      l.ip || "—"
    ]),
    styles: { font: "helvetica", fontSize: 7.5, cellPadding: 5, textColor: ink, lineColor: [225, 230, 227], lineWidth: 0.5 },
    headStyles: { fillColor: emerald, textColor: 255, fontStyle: "bold", fontSize: 8 },
    alternateRowStyles: { fillColor: [242, 249, 246] },
    columnStyles: { 0: { cellWidth: 108 }, 1: { cellWidth: 88 }, 2: { cellWidth: 96 }, 4: { cellWidth: 210 } },
    margin: { left: 40, right: 40, bottom: 40 },
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.setTextColor(130, 138, 133);
      doc.setFont("helvetica", "normal");
      doc.text("RetailFlow Admin Console — confidential audit export", 40, pageH - 18);
      doc.text("Page " + doc.internal.getNumberOfPages(), pageW - 70, pageH - 18);
      doc.setDrawColor(225, 230, 227);
      doc.line(40, pageH - 30, pageW - 40, pageH - 30);
    }
  };
  if (doc.autoTable) doc.autoTable(table);

  doc.save("retailflow-audit-" + new Date().toISOString().slice(0, 10) + ".pdf");
  showToast("success", "PDF downloaded", list.length + " audit record" + (list.length === 1 ? "" : "s") + " exported.");
}

/* ================================================================
   VIEW: SETTINGS  (form helpers)
   ================================================================ */
function formField(label, name, type, value, opts) {
  const v = value == null ? "" : value;
  let input;
  if (type === "select") {
    input = '<select id="' + name + '" name="' + name + '">';
    (opts || []).forEach((o) => {
      const ov = o.value != null ? o.value : o;
      const ol = o.label != null ? o.label : o;
      input += '<option value="' + esc(ov) + '"' + (String(ov) === String(v) ? " selected" : "") + ">" + esc(ol) + "</option>";
    });
    input += "</select>";
  } else if (type === "textarea") {
    input = '<textarea id="' + name + '" name="' + name + '">' + esc(v) + "</textarea>";
  } else if (type === "checkbox") {
    return '<div class="toggle-row"><div><div class="t-label">' + esc(label) + '</div></div><label class="switch"><input type="checkbox" id="' + name + '" name="' + name + '"' + (v ? " checked" : "") + '><span class="track"></span></label></div>';
  } else {
    input = '<input type="' + (type || "text") + '" id="' + name + '" name="' + name + '" value="' + esc(v) + '">';
  }
  return '<div class="form-field"><label for="' + name + '">' + esc(label) + "</label>" + input + "</div>";
}

function toggleField(label, name, desc, checked) {
  return '<div class="toggle-row"><div><div class="t-label">' + esc(label) + '</div><div class="t-desc">' + esc(desc || "") + '</div></div>'
    + '<label class="switch"><input type="checkbox" id="' + name + '" name="' + name + '"' + (checked ? " checked" : "") + '><span class="track"></span></label></div>';
}

function settingsFormGrid(...fields) {
  return '<div class="form-grid">' + fields.join("") + "</div>";
}

const SETTINGS_TABS = [
  { key: "business", label: "Business Profile", icon: "building" },
  { key: "pos", label: "POS Settings", icon: "receipt" },
  { key: "payments", label: "Payments", icon: "money-bill-transfer" },
  { key: "users", label: "Users & Permissions", icon: "user-gear" },
  { key: "branch", label: "Branch Settings", icon: "code-branch" },
  { key: "system", label: "System Settings", icon: "gear" }
];

async function renderSettings() {
  const p = state.profile;
  state.settingsTab = state.settingsTab || "business";
  let targetBiz = p.role === "owner"
    ? (db.businesses.find((b) => b.id === (state.settingsBusinessId || db.businesses[0]?.id)) || db.businesses[0])
    : db.businesses.find((b) => b.id === p.businessId);
  // Load current settings from server so the form shows saved values
  if (targetBiz && targetBiz.id) {
    try { await apiGetSettings(targetBiz.id); } catch (e) { /* use defaults */ }
  }
  const tabs = SETTINGS_TABS.map((t) => '<button type="button" class="tab-btn' + (t.key === state.settingsTab ? " active" : "") + '" data-tab="' + t.key + '">'
    + '<i class="fa-solid fa-' + t.icon + '" aria-hidden="true"></i> ' + esc(t.label) + "</button>").join("");
  const sc = scope();
  const curBranches = db.branches.filter((b) => b.businessId === (targetBiz && targetBiz.id));

  /* Safe M-Pesa metadata for the Payments tab (never credentials). */
  let mpesaConfig = null;
  if (p.role === "owner" || p.role === "admin") {
    try { mpesaConfig = await apiGetMpesaConfig(targetBiz && targetBiz.id); } catch (e) { mpesaConfig = null; }
  }

  contentEl.innerHTML = '<section class="view" data-view="settings"><form id="settingsForm">'
    + '<div class="tabs">' + tabs + "</div>"
    + settingsBusinessPanel(p, targetBiz)
    + settingsPosPanel(targetBiz)
    + ((p.role === "owner" || p.role === "admin") ? settingsPaymentsPanel(targetBiz, mpesaConfig) : "")
    + settingsUsersPanel()
    + settingsBranchPanel(p, targetBiz, curBranches)
    + settingsSystemPanel(targetBiz)
    + '<div class="modal-foot modal-foot-sticky"><button type="button" class="btn btn-ghost btn-sm" data-act="cancel_settings">Cancel</button>'
    + '<button type="submit" class="btn btn-primary btn-sm" data-act="save_settings"><i class="fa-solid fa-save" aria-hidden="true"></i> Save settings</button></div></form></section>';
  wireSettingsTabs();
}

function settingsBusinessPanel(p, biz) {
  const picker = (p.role === "owner")
    ? '<div class="form-field"><label for="settingsBiz">Business to edit</label><select id="settingsBiz" data-act="pick_business">'
      + db.businesses.map((b) => '<option value="' + b.id + '"' + (b.id === (state.settingsBusinessId || (biz && biz.id)) ? " selected" : "") + ">" + esc(b.name) + "</option>").join("")
      + "</select></div>"
    : "";
  return tabPanel("business", state.settingsTab === "business", settingsFormGrid(
    picker,
    '<div class="form-field"><label for="type">Business type</label><select id="type" name="type">'
      + BUSINESS_TYPE_OPTIONS.map((t) => '<option value="' + esc(t.value) + '"' + (t.value === normalizeTypeCode(biz && (biz.typeCode || biz.type)) ? ' selected' : '') + '>' + esc(t.label) + '</option>').join('')
      + '</select></div>',
    formField("Business name", "name", "text", biz && biz.name),
    '<div class="form-field span-2">' + modulesPreviewHtml(biz || {}) + '</div>',
    formField("Phone", "phone", "tel", biz && biz.phone),
    formField("Email", "email", "email", biz && biz.email),
    formField("Address", "address", "text", biz && biz.address),
    formField("City", "city", "text", biz && biz.city),
    formField("Country", "country", "text", biz && biz.country),
    formField("Registration #", "regNo", "text", biz && biz.regNo),
    formField("Tax/VAT #", "taxNo", "text", biz && biz.taxNo),
    formField("Currency", "currency", "select", biz && biz.currency, CURRENCIES),
    formField("Timezone", "timezone", "select", biz && biz.timezone, TIMEZONES)
  ));
}

function settingsPosPanel(biz) {
  /* Receipt footer shows the type-aware default for the business in scope
     (restaurant → "dining", hotel → "welcome back", …). A custom value the
     owner types here is what the POS prints; the generic retail default is
     never shown for non-retail types. */
  const footerValue = receiptFooterFor(biz || {});
  const s = db.settings || {};
  return tabPanel("pos", state.settingsTab === "pos", settingsFormGrid(
    toggleField("Paperless receipt printing", "receiptPaperless", "Print receipts automatically after each sale.", s.receiptPaperless !== false),
    toggleField("Barcode scanner", "barcodeScanner", "Scan products at checkout.", s.barcodeScanner !== false),
    toggleField("Customer display", "customerDisplay", "Show promotions on the customer-facing screen.", s.customerDisplay === true),
    formField("Receipt footer", "receiptFooter", "text", footerValue),
    '<div class="form-field span-2" style="border-top:1px solid var(--line);padding-top:14px;margin-top:6px">'
      + '<div class="form-field-label" style="font-weight:700;color:var(--ink);margin-bottom:10px">Receipt Numbering</div></div>',
    formField("Receipt prefix", "receiptPrefix", "text", s.receiptPrefix || "RF",
      [{ label: "Letters/short code printed before the number (e.g. RF, STORE)", value: "" }]),
    formField("Numbering format", "receiptNumbering", "select", s.receiptNumbering || "date-random", [
      { label: "Date + Random (RF-20260904-123456)", value: "date-random" },
      { label: "Sequential (RF-000001, RF-000002...)", value: "sequential" },
      { label: "Date + Cashier (RF-20260904-JD-123)", value: "date-cashier" },
      { label: "Year + Sequential (RF-2026-000001)", value: "year-sequential" }
    ]),
    formField("Number padding", "receiptPadding", "select", String(s.receiptPadding || 6), [
      { label: "4 digits (0001)", value: "4" },
      { label: "6 digits (000001)", value: "6" },
      { label: "8 digits (00000001)", value: "8" }
    ]),
    '<div class="form-field span-2" style="border-top:1px solid var(--line);padding-top:14px;margin-top:6px">'
      + '<div class="form-field-label" style="font-weight:700;color:var(--ink);margin-bottom:10px">Tax & Payments</div></div>',
    toggleField("Enable tax", "enableTax", "Apply tax to sales.", s.enableTax !== false),
    formField("Tax rate (%)", "taxRate", "text", s.taxRate != null ? String(s.taxRate) : "0",
      [{ label: "Tax percentage (e.g. 16 for 16%)", value: "0" }]),
    toggleField("Enable discounts", "enableDiscounts", "Allow discounts at checkout.", s.enableDiscounts !== false),
    formField("Payment methods", "paymentMethods", "select", "Cash", [
      { label: "Cash, M-Pesa, Card", value: '["Cash","M-Pesa","Card"]' },
      { label: "Cash, M-Pesa", value: '["Cash","M-Pesa"]' },
      { label: "Cash only", value: '["Cash"]' },
      { label: "Cash, Card", value: '["Cash","Card"]' }
    ]),
    formField("Default payment method", "defaultPayment", "select", s.defaultPayment || "Cash", PAYMENT_METHODS.map((m) => ({ label: m, value: m }))),
    formField("Refund password", "refundPassword", "text", "", [{ label: "(none)", value: "" }])
  ));
}

/* ================================================================
   SETTINGS → PAYMENTS  (M-Pesa Daraja configuration)
   Credentials are write-only: the Worker returns safe metadata only,
   and saved values display as masked dots with "Configured ✓".
   ================================================================ */
function settingsPaymentsPanel(biz, cfg) {
  const configured = !!(cfg && cfg.configured);
  const enabled = !!(cfg && cfg.enabled);
  const passkeySet = !!(cfg && cfg.passkeyConfigured);
  const env = (cfg && cfg.environment) || "sandbox";
  const shortcodeType = (cfg && cfg.shortcodeType) || "Till";
  const shortcode = (cfg && cfg.shortcode) || "";
  const accountRef = (cfg && cfg.accountReference) || "RetailFlow";
  const status = (cfg && cfg.connectionStatus) || "Not Configured";
  const statusDot =
    status === "Connected" ? '<span class="mp-status-dot is-ok"></span>'
    : status === "Connection Failed" ? '<span class="mp-status-dot is-bad"></span>'
    : '<span class="mp-status-dot is-idle"></span>';

  const credentialsBlock = configured
    ? '<div class="form-field span-2" style="border-top:1px solid var(--line);padding-top:14px;margin-top:6px">'
      + '<div class="form-field-label" style="font-weight:700;color:var(--ink);margin-bottom:10px">Daraja Credentials</div>'
      + '<div class="mp-cred-row"><span>Consumer Key</span><span class="mp-cred-masked">••••••••••••••••</span><span class="badge badge-success">Configured ✓</span></div>'
      + '<div class="mp-cred-row"><span>Consumer Secret</span><span class="mp-cred-masked">••••••••••••••••</span><span class="badge badge-success">Configured ✓</span></div>'
      + '<div class="mp-cred-row"><span>Passkey</span><span class="mp-cred-masked">' + (passkeySet ? "••••••••••••••••" : "—") + '</span>'
      + (passkeySet
        ? '<span class="badge badge-success">Configured ✓</span>'
        : '<span class="badge badge-neutral">Not set — optional</span>') + '</div>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-act="mpesa_replace_credentials" style="margin-top:10px">'
      + '<i class="fa-solid fa-key" aria-hidden="true"></i> Replace Credentials</button></div>'
    + '<div class="mp-cred-inputs hidden" id="mpesaCredInputs">'
      + formField("Consumer Key", "mpesaConsumerKey", "text", "")
      + formField("Consumer Secret", "mpesaConsumerSecret", "password", "")
      + formField("Passkey", "mpesaPasskey", "password", "")
      + '<p class="sec-desc" style="font-size:0.75rem;margin:2px 0 0">Optional — Test Connection works with just the Consumer Key and Secret. Required for STK Push. Sandbox apps may show "Passkey: N/A".</p>'
      + "</div>"
    : '<div class="form-field span-2" style="border-top:1px solid var(--line);padding-top:14px;margin-top:6px">'
      + '<div class="form-field-label" style="font-weight:700;color:var(--ink);margin-bottom:10px">Daraja Credentials</div></div>'
      + '<div class="mp-cred-inputs" id="mpesaCredInputs">'
      + formField("Consumer Key", "mpesaConsumerKey", "text", "")
      + formField("Consumer Secret", "mpesaConsumerSecret", "password", "")
      + formField("Passkey", "mpesaPasskey", "password", "")
      + '<p class="sec-desc" style="font-size:0.75rem;margin:2px 0 0">Passkey is optional — Test Connection works with just the Consumer Key and Secret. Required for STK Push. Sandbox apps may show "Passkey: N/A".</p>'
      + "</div>";

  return tabPanel("payments", state.settingsTab === "payments",
    '<div class="mp-status-line">' + statusDot + '<span>Connection Status</span><strong>' + esc(status) + "</strong></div>"
    + settingsFormGrid(
      toggleField("Enable M-Pesa", "mpesaEnabled", "Show M-Pesa as a payment method at the POS.", enabled),
      formField("Environment", "mpesaEnvironment", "select", env, [
        { label: "Sandbox (testing)", value: "sandbox" },
        { label: "Production (live)", value: "production" }
      ]),
      formField("Shortcode Type", "mpesaShortcodeType", "select", shortcodeType, [
        { label: "Till Number", value: "Till" },
        { label: "PayBill", value: "PayBill" }
      ]),
      formField("Shortcode / Till Number", "mpesaShortcode", "text", shortcode),
      formField("Account Reference", "mpesaAccountRef", "text", accountRef),
      formField("Transaction Description", "mpesaTransactionDesc", "text", (cfg && cfg.transactionDesc) || "Payment"),
      credentialsBlock,
      '<div class="form-field span-2"><label>Callback URL</label>'
        + '<div class="mp-callback-url"><i class="fa-solid fa-lock" aria-hidden="true"></i> '
        + esc(API_BASE) + "/api/mpesa/callback"
        + '</div><p class="sec-desc">Automatically managed by RetailFlow — no manual setup required.</p></div>',
      '<div class="form-field span-2 mp-actions-row">'
        + '<button type="button" class="btn btn-primary btn-sm" data-act="mpesa_save_config"><i class="fa-solid fa-save" aria-hidden="true"></i> Save Configuration</button>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-act="mpesa_test"><i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i> Test Connection</button>'
        + "</div>"
    ));
}

/* Collect the Payments-tab fields into a PUT payload. Blank credential
   fields are omitted so existing encrypted values are kept. The
   Passkey is independent and optional — blank means "keep existing". */
function readMpesaConfigForm() {
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || "").trim() : "";
  };
  const isChecked = (id) => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  };
  const payload = {
    enabled: isChecked("mpesaEnabled"),
    environment: val("mpesaEnvironment") || "sandbox",
    shortcodeType: val("mpesaShortcodeType") || "Till",
    shortcode: val("mpesaShortcode"),
    accountReference: val("mpesaAccountRef"),
    transactionDesc: val("mpesaTransactionDesc")
  };
  const consumerKey = val("mpesaConsumerKey");
  const consumerSecret = val("mpesaConsumerSecret");
  const passkey = val("mpesaPasskey");
  if (consumerKey && consumerSecret) {
    payload.consumerKey = consumerKey;
    payload.consumerSecret = consumerSecret;
  }
  if (passkey) {
    payload.passkey = passkey;
  }
  return payload;
}

/* The business currently being edited in Settings. */
function mpesaSettingsBusiness() {
  const p = state.profile || {};
  if (p.role === "owner") {
    return db.businesses.find((b) => b.id === state.settingsBusinessId) || db.businesses[0] || null;
  }
  return db.businesses.find((b) => b.id === p.businessId) || null;
}

/* Save the M-Pesa configuration (standalone action — NOT part of the
   main settings save, because credentials are write-only). */
async function saveMpesaConfigAction() {
  const biz = mpesaSettingsBusiness();
  if (!biz) { showToast("error", "No business", "Select a business first."); return; }

  const payload = readMpesaConfigForm();
  if (!payload.shortcode) {
    showToast("error", "Missing shortcode", "Enter your Till Number or PayBill shortcode.");
    return;
  }
  if (!payload.consumerKey && !state._mpesaConfigured) {
    showToast("error", "Missing credentials", "Consumer Key and Consumer Secret are required for first-time setup. The Passkey is optional.");
    return;
  }

  try {
    await apiSaveMpesaConfig(biz.id, payload);
    state._mpesaConfigured = true;
    showToast("success", "M-Pesa saved", "Your Daraja configuration has been stored securely.");
    await renderSettings();
  } catch (err) {
    showToast("error", "Save failed", err && err.message ? err.message : "Please try again.");
  }
}

async function testMpesaConnectionAction() {
  const biz = mpesaSettingsBusiness();
  if (!biz) return;
  try {
    const resp = await apiTestMpesa(biz.id);
    showToast("success", "Connection OK", (resp && resp.message) || "M-Pesa connection successful.");
    await renderSettings();
  } catch (err) {
    showToast("error", "Connection failed", err && err.message ? err.message : "Please check your Daraja credentials.");
    await renderSettings();
  }
}

/* ---- M-Pesa transaction detail + resolve ---- */
async function viewMpesaModal(row) {
  let tx = row;
  try { tx = (await apiGetMpesaTransaction(row.id)) || row; } catch (e) { /* fall back to the row */ }
  const body = '<div class="detail-grid">'
    + detailItem("Status", tx.status || "—")
    + detailItem("Amount", money(tx.amount))
    + detailItem("Phone", maskPhoneLocal(tx.phone_number))
    + detailItem("M-Pesa Receipt", tx.mpesa_receipt_number || "—")
    + detailItem("Checkout Request ID", tx.checkout_request_id || "—")
    + detailItem("Merchant Request ID", tx.merchant_request_id || "—")
    + detailItem("Sale Receipt", tx.sale_receipt_number || tx.receipt_number || "—")
    + detailItem("Branch", tx.branch_name || branchName(tx.branch_id))
    + detailItem("Date", fmtDateTime(tx.created_at || tx.date))
    + detailItem("Result", tx.result_description || "—")
    + "</div>"
    + (tx.result_code != null ? '<p class="sec-desc" style="margin-top:10px">Result code: ' + esc(tx.result_code) + "</p>" : "");
  const canResolve = (state.profile.role === "owner" || state.profile.role === "admin")
    && (tx.status === "Underpaid" || tx.status === "Pending");
  openModal({
    title: "M-Pesa Transaction",
    sub: mpesaStatusBadge(tx.status),
    wide: false,
    body,
    footer: canResolve
      ? '<button type="button" class="btn btn-primary btn-sm" data-act="mpesa_resolve_complete" data-id="' + esc(tx.id) + '"><i class="fa-solid fa-check" aria-hidden="true"></i> Complete sale</button>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-act="mpesa_resolve_void" data-id="' + esc(tx.id) + '"><i class="fa-solid fa-ban" aria-hidden="true"></i> Void</button>'
      : '<button type="button" class="btn btn-ghost btn-sm" data-modal-cancel>Close</button>',
    onOpen: (ov) => {
      const cancel = ov.querySelector("[data-modal-cancel]");
      if (cancel) cancel.addEventListener("click", closeModal);
    }
  });
}

async function resolveMpesaTransactionAction(row, action) {
  const label = action === "complete" ? "complete" : "void";
  if (!window.confirm("Are you sure you want to " + label + " this M-Pesa transaction?")) return;
  try {
    await apiResolveMpesaTransaction(row.id, action);
    showToast("success", "Transaction updated", action === "complete"
      ? "The sale has been completed and stock deducted."
      : "The transaction has been voided.");
    rerenderCurrent();
  } catch (err) {
    showToast("error", "Resolve failed", err && err.message ? err.message : "Please try again.");
  }
}

function settingsUsersPanel() {
  return tabPanel("users", state.settingsTab === "users", settingsFormGrid(
    toggleField("Staff can view reports", "staffReports", "Allow staff to open the Reports section.", false),
    toggleField("Staff can issue refunds", "staffRefunds", "Allow cashiers to process refunds.", false),
    toggleField("Low stock alerts", "lowStockAlerts", "Notify managers when stock is low.", true),
    toggleField("Multi-branch switching", "multiBranch", "Let admins switch between branches.", true)
  ) + '<p class="sec-desc" style="margin-top:10px">Role permissions are enforced by the Cloudflare backend. These toggles preview the intended UI behaviour.</p>');
}

function settingsBranchPanel(p, biz, curBranches) {
  return tabPanel("branch", state.settingsTab === "branch", settingsFormGrid(
    '<div class="form-field"><label for="manageBranch">Manage branch</label><select id="manageBranch">'
      + curBranches.map((b) => '<option value="' + b.id + '">' + esc(b.name) + " (" + esc(b.code) + ")</option>").join("")
      + "</select></div>",
    formField("Branch name", "branchName", "text", ""),
    formField("Branch code", "branchCode", "text", ""),
    formField("Manager", "branchManager", "text", ""),
    formField("Phone", "branchPhone", "tel", ""),
    formField("Email", "branchEmail", "email", "")
  ) + (curBranches.length ? "" : '<p class="empty-msg">No branches configured for this business yet.</p>'));
}

function settingsSystemPanel(biz) {
  return tabPanel("system", state.settingsTab === "system", settingsFormGrid(
    formField("Currency", "sysCurrency", "select", (biz && biz.currency) || "KES", CURRENCIES),
    formField("Timezone", "sysTimezone", "select", (biz && biz.timezone) || "Africa/Nairobi", TIMEZONES),
    formField("Date format", "dateFormat", "select", "DD/MM/YYYY",
      [{ label: "DD/MM/YYYY", value: "DD/MM/YYYY" }, { label: "MM/DD/YYYY", value: "MM/DD/YYYY" }, { label: "YYYY-MM-DD", value: "YYYY-MM-DD" }]),
    formField("Language", "language", "select", "English",
      [{ label: "English", value: "English" }, { label: "Français", value: "Français" }, { label: "Kiswahili", value: "Kiswahili" }]),
    toggleField("Email notifications", "emailNotifications", "Send emails for sales and low stock.", true),
    toggleField("Audit logging", "auditLogging", "Record all admin actions to the audit log.", true)
  ));
}

function wireSettingsTabs() {
  const root = contentEl.querySelector('[data-view="settings"]');
  if (!root) return;
  root.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll(".tab-btn").forEach((t) => t.classList.toggle("active", t === btn));
      root.querySelectorAll(".tab-panel").forEach((p2) => p2.classList.toggle("active", p2.dataset.tab === btn.dataset.tab));
      state.settingsTab = btn.dataset.tab;
    });
  });
  wireBusinessTypeControls(root);
}

/* ================================================================
   VIEW REGISTRY + ACTION DISPATCH
   ================================================================ */
const renderViews = {
  overview: renderOverview, businesses: renderBusinesses, staff: renderStaff,
  branches: renderBranches, products: renderProducts, inventory: renderInventory,
  sales: renderSales, mpesa: renderMpesa, refunds: renderRefunds, purchases: renderPurchases, customers: renderCustomers,
  suppliers: renderSuppliers, expenses: renderExpenses, reports: renderReports,
  audit: renderAuditLogs, settings: renderSettings
};

function findRow(view, id) {
  const m = {
    businesses: db.businesses, staff: db.staff, branches: db.branches,
    products: db.products, sales: db.sales, refunds: db.refunds, purchases: db.purchases,
    customers: db.customers, suppliers: db.suppliers, expenses: db.expenses,
    audit: db.auditLogs
  };
  const a = m[view]; return a ? a.find((x) => x.id === id) : null;
}

/* Central dispatcher for every [data-act] button (toolbar + row actions + settings). */
function handleAction(act, id, view) {
  const row = id ? findRow(view, id) : null;
  const rerender = () => { if (renderViews[state.view]) renderViews[state.view](); };
  switch (act) {
    case "add_business":  addBusinessModal(); break;
    case "edit_business": addBusinessModal(row); break;
    case "view_business": openBusinessDetail(id); break;
    case "suspend_business":  case "activate_business":
      apiUpdateBusiness(id, { status: act === "suspend_business" ? "Suspended" : "Active" }).then(() => {
        showToast("success", "Status updated", "Business " + (act === "activate_business" ? "activated" : "suspended") + "."); rerender();
      }).catch((e) => showToast("error", "Update failed", e && e.message ? e.message : "Please try again.")); break;
    case "add_staff":  addStaffModal(); break;
    case "edit_staff": addStaffModal(row); break;
    case "change_role_staff": changeRoleModal(row); break;
    case "assign_branch_staff": assignBranchModal(row); break;
    case "suspend_staff":  case "activate_staff":
      apiUpdateStaff(id, { status: act === "suspend_staff" ? "Suspended" : "Active" }).then(() => {
        showToast("success", "Staff status updated", ""); rerender();
      }).catch((e) => showToast("error", "Update failed", e && e.message ? e.message : "Please try again.")); break;
    case "reset_staff":
      showToast("info", "Reset access", "A password reset link will be sent to " + (row && row.email) + "."); break;
    case "add_branch":  addBranchModal(); break;
    case "edit_branch": addBranchModal(row); break;
    case "deactivate_branch":  case "activate_branch":
      apiUpdateBranch(id, { status: act === "deactivate_branch" ? "Suspended" : "Active" }).then(() => {
        showToast("success", "Branch status updated", ""); rerender();
      }).catch((e) => showToast("error", "Update failed", e && e.message ? e.message : "Please try again.")); break;
    case "add_product":  addProductModal(); break;
    case "edit_product": addProductModal(row); break;
    case "print_barcode":
      if (!row) { showToast("error", "Select a product", "Choose a product row first."); break; }
      showBarcodePrintModal(row); break;
    case "adjust_stock":
      if (!row) { showToast("error", "Select a product", "Choose a product row first."); break; }
      adjustStockModal(row); break;
    case "archive_product":
      apiUpdateProduct(id, { status: "Archived" }).then(() => {
        showToast("success", "Product archived", ""); rerender();
      }).catch((e) => showToast("error", "Update failed", e && e.message ? e.message : "Please try again.")); break;
    case "add_purchase": addPurchaseModal(); break;
    case "add_expense": addExpenseModal(); break;
    case "add_customer": addCustomerModal(); break;
    case "edit_customer": addCustomerModal(row); break;
    case "add_supplier": addSupplierModal(); break;
    case "edit_supplier": addSupplierModal(row); break;
    case "view_sale": viewSaleModal(row); break;
    case "export_sales_pdf": exportSalesPdf(); break;
    case "view_audit":
      if (!row) { showToast("error", "Select a record", "Choose an audit log row first."); break; }
      viewAuditModal(row); break;
    case "view_refund":
      if (!row) { showToast("error", "Select a refund", "Choose a refund request row first."); break; }
      viewRefundModal(row); break;
    case "approve_refund": case "reject_refund":
      if (!row) { showToast("error", "Select a refund", "Choose a refund request row first."); break; }
      decideRefundModal(row, act === "approve_refund" ? "Approved" : "Rejected"); break;
    case "refresh_refunds":
      apiGetRefunds(state.profile.businessId, state.profile.branchId)
        .then(() => { showToast("info", "Refreshed", "Refund requests are up to date."); rerender(); })
        .catch((e) => showToast("error", "Refresh failed", e && e.message ? e.message : "Please try again."));
      break;
    case "refresh_sales":
      resetDbCache();
      apiGetSales(state.profile.businessId, state.profile.branchId)
        .then(() => { showToast("info", "Refreshed", "Sales data is up to date."); rerender(); })
        .catch((e) => showToast("error", "Refresh failed", e && e.message ? e.message : "Please try again."));
      break;
    case "view_purchase": viewDocModal(row, "Purchase " + row.id, detailGridFrom(row, ["supplier", "date", "items", "total", "status"])); break;
    case "view_product": viewDocModal(row, row.name, (row.image ? '<div class="detail-img"><img src="' + esc(row.image) + '" alt="Product image"></div>' : "") + detailGridFrom(row, ["sku", "barcode", "category", "stock", "reorderLevel", "price", "tax"])); break;
    case "view_staff": viewDocModal(row, row.name, detailGridFrom(row, ["email", "role", "businessId", "branchId", "status", "lastLogin"])); break;
    case "view_branch": viewDocModal(row, row.name, detailGridFrom(row, ["code", "businessId", "location", "phone", "manager", "status"])); break;
    case "quick_sale": showToast("info", "Checkout", "POS checkout is under development."); break;
    case "save_settings": saveSettings(); break;
    case "audit_pdf": downloadAuditPdf(); break;
    case "cancel_settings": renderSettings(); break;
    case "pick_business":
      state.settingsBusinessId = document.getElementById("settingsBiz").value;
      renderSettings(); break;

    /* ---- M-Pesa (Daraja) ---- */
    case "mpesa_configure":
      state.settingsTab = "payments";
      switchView("settings");
      break;
    case "mpesa_save_config": void saveMpesaConfigAction(); break;
    case "mpesa_test": void testMpesaConnectionAction(); break;
    case "mpesa_replace_credentials": {
      const inputs = document.getElementById("mpesaCredInputs");
      if (inputs) inputs.classList.remove("hidden");
      break;
    }
    case "view_mpesa":
      if (!row) { showToast("error", "Select a record", "Choose an M-Pesa transaction row first."); break; }
      viewMpesaModal(row);
      break;
    case "mpesa_resolve_complete":
    case "mpesa_resolve_void":
      if (!row) { showToast("error", "Select a record", "Choose an M-Pesa transaction row first."); break; }
      resolveMpesaTransactionAction(row, act === "mpesa_resolve_complete" ? "complete" : "void");
      break;

    default: break;
  }
}

/* Detail grid builder for view modals */
function detailGridFrom(row, fields) {
  const label = (f) => f.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
  const fmt = (f, v) => {
    if (f === "businessId") return businessName(v);
    if (f === "branchId") return branchName(v);
    if (["amount", "total", "outstanding", "totalPurchases", "balance"].includes(f)) return v != null ? money(v) : "—";
    if (f === "items") return purchaseItemCount(row) + " item(s)";
    if (f === "date" || f === "lastLogin") return v ? fmtDate(v) : "—";
    return esc(v == null ? "" : v);
  };
  return '<div class="detail-grid">' + fields.map((f) =>
    '<div class="detail-item"><div class="d-label">' + label(f) + '</div><div class="d-value">' + fmt(f, row[f]) + "</div></div>").join("") + "</div>";
}

function viewDocModal(row, title, bodyHtml) {
  openModal({
    title, sub: "", wide: false, body: bodyHtml,
    footer: '<button type="button" class="btn btn-ghost btn-sm" data-modal-cancel><i class="fa-solid fa-xmark" aria-hidden="true"></i> Close</button>',
    onOpen: (ov) => { const c = ov.querySelector("[data-modal-cancel]"); if (c) c.addEventListener("click", closeModal); }
  });
}

function changeRoleModal(row) {
  buildFormModal({
    title: "Change role: " + row.name,
    sub: "Assign a new role to this staff member.",
    sections: [{
      title: "Role", icon: "fa-user-gear",
      fields: [{ name: "role", label: "Role", type: "select", options: Object.keys(ROLE_VALUE).map((l) => ({ label: l, value: ROLE_VALUE[l] })), required: true }]
    }],
    submitLabel: "Update role",
    defaults: { role: row.role },
    onSubmit: async function (data) {
      await apiUpdateStaff(row.id, { role: data.role });
      showToast("success", "Role updated", row.name + " is now a " + data.role + ".");
    }
  });
}

function assignBranchModal(row) {
  const opts = db.branches.map((b) => ({ label: b.name + " (" + businessName(b.businessId) + ")", value: b.id }));
  buildFormModal({
    title: "Assign branch: " + row.name,
    sub: "Move this staff member to a different branch.",
    sections: [{
      title: "Branch assignment", icon: "fa-code-branch",
      fields: [{ name: "branchId", label: "Branch", type: "select", options: [{ label: "— No branch", value: "" }].concat(opts), required: true }]
    }],
    submitLabel: "Assign branch",
    defaults: { branchId: row.branchId || "" },
    onSubmit: async function (data) {
      await apiUpdateStaff(row.id, { branchId: data.branchId || null });
      showToast("success", "Branch updated", row.name + " reassigned.");
    }
  });
}

function saveSettings() {
  const form = document.getElementById("settingsForm");
  if (!form) return;
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = v; });
  // Unchecked checkboxes are NOT included in FormData — detect them manually
  form.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    if (!data.hasOwnProperty(cb.name)) data[cb.name] = "false";
  });
  const p = state.profile;
  const biz = (p.role === "owner")
    ? (db.businesses.find((b) => b.id === (state.settingsBusinessId || db.businesses[0]?.id)) || db.businesses[0])
    : db.businesses.find((b) => b.id === p.businessId);
  if (biz) {
    const code = normalizeTypeCode(data.type || biz.typeCode || biz.type);
    let enabledModules = null;
    if (typeof data.enabledModules === "string" && data.enabledModules.trim()) {
      try { enabledModules = JSON.parse(data.enabledModules); } catch (e) { enabledModules = null; }
    }
    // Save business profile
    apiUpdateBusiness(biz.id, {
      name: data.name, typeCode: code, type: typeDef(code).label,
      phone: data.phone, email: data.email, address: data.address,
      city: data.city, country: data.country, regNo: data.regNo, taxNo: data.taxNo,
      currency: data.currency || data.sysCurrency, timezone: data.timezone || data.sysTimezone,
      enabledModules: enabledModules
    }).catch((err) => {
      console.warn("[RetailFlow] business settings save failed:", err);
      showToast("error", "Settings not saved", err && err.message ? err.message : "Please try again.");
    });
    // Save POS settings (receipt numbering, footer, tax, etc.)
    apiUpdateSettings(biz.id, {
      // Receipt settings
      receiptFormat: data.receiptFormat || "Standard 80mm",
      receiptFooter: data.receiptFooter || "",
      receiptPrefix: data.receiptPrefix || "RF",
      receiptNumbering: data.receiptNumbering || "date-random",
      receiptPadding: data.receiptPadding || 6,
      // Tax settings
      enableTax: data.enableTax === "true" || data.enableTax === "on" || data.enableTax === true,
      taxRate: data.taxRate != null && data.taxRate !== "" ? Number(data.taxRate) : 0,
      enableDiscounts: data.enableDiscounts === "true" || data.enableDiscounts === "on" || data.enableDiscounts === true,
      paymentMethods: data.paymentMethods || ["Cash", "M-Pesa", "Card"],
      // System settings
      dateFormat: data.dateFormat || "DD/MM/YYYY",
      language: data.language || "English",
      enableEmailNotifications: data.enableEmailNotifications === "true" || data.enableEmailNotifications === "on" || data.enableEmailNotifications === true,
      enableAudit: data.enableAudit === "true" || data.enableAudit === "on" || data.enableAudit === true,
      // POS-specific toggles
      receiptPaperless: data.receiptPaperless === "true" || data.receiptPaperless === "on" || data.receiptPaperless === true,
      barcodeScanner: data.barcodeScanner === "true" || data.barcodeScanner === "on" || data.barcodeScanner === true,
      customerDisplay: data.customerDisplay === "true" || data.customerDisplay === "on" || data.customerDisplay === true,
      // User permissions
      staffReports: data.staffReports === "true" || data.staffReports === "on" || data.staffReports === true,
      staffRefunds: data.staffRefunds === "true" || data.staffRefunds === "on" || data.staffRefunds === true,
      lowStockAlerts: data.lowStockAlerts === "true" || data.lowStockAlerts === "on" || data.lowStockAlerts === true,
      multiBranch: data.multiBranch === "true" || data.multiBranch === "on" || data.multiBranch === true,
      // POS extras
      defaultPayment: data.defaultPayment || "Cash",
      refundPassword: data.refundPassword || ""
    }).catch((err) => {
      console.warn("[RetailFlow] POS settings save failed:", err);
    });
    // Save branch settings if a branch is selected
    const branchId = data.manageBranch || (db.branches[0] && db.branches[0].id);
    if (branchId && data.branchName) {
      apiUpdateBranch(branchId, {
        name: data.branchName,
        code: data.branchCode || "",
        manager: data.branchManager || "",
        phone: data.branchPhone || "",
        email: data.branchEmail || ""
      }).catch((err) => {
        console.warn("[RetailFlow] branch settings save failed:", err);
      });
    }
  }
  state.appSettings = Object.assign(state.appSettings || {}, data);
  showToast("success", "Settings saved", "Your preferences have been updated.");
}

/* ================================================================
   INIT: sidebar, top bar, event delegation, auth bootstrap
   ================================================================ */
let _searchTimer = 0;

function rerenderCurrent() {
  if (renderViews[state.view]) renderViews[state.view]();
}

function initApp() {
  const menuBtn = document.getElementById("menuBtn");
  const sideClose = document.getElementById("sideClose");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");
  const topUser = document.getElementById("topUser");
  const userMenu = document.getElementById("userMenu");
  const menuSignOut = document.getElementById("menuSignOut");
  const logoutBtn = document.getElementById("logoutBtn");

  // Mobile sidebar toggle
  menuBtn && menuBtn.addEventListener("click", () => shellEl.classList.add("nav-open"));
  sideClose && sideClose.addEventListener("click", () => shellEl.classList.remove("nav-open"));
  sidebarBackdrop && sidebarBackdrop.addEventListener("click", () => shellEl.classList.remove("nav-open"));

  // Top-bar user menu
  topUser && topUser.addEventListener("click", (e) => { e.stopPropagation(); if (userMenu) userMenu.hidden = !userMenu.hidden; });
  menuSignOut && menuSignOut.addEventListener("click", signOutUser);
  logoutBtn && logoutBtn.addEventListener("click", signOutUser);
  document.addEventListener("click", () => { if (userMenu) userMenu.hidden = true; });

  // Sidebar navigation
  sideNav && sideNav.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item");
    if (btn) switchView(btn.dataset.view);
  });

  // Click delegation: action buttons (toolbar + row actions + settings)
  document.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (btn) {
      e.preventDefault();
      const view = btn.closest("[data-view]") ? btn.closest("[data-view]").dataset.view : null;
      handleAction(btn.dataset.act, btn.dataset.id, view);
      return;
    }
    const pg = e.target.closest("[data-pager]");
    if (pg) {
      const vk = pg.dataset.viewkey;
      const st = state.filters[vk] = state.filters[vk] || {};
      st.page = (pg.dataset.pager === "prev") ? st.page - 1 : st.page + 1;
      rerenderCurrent();
      return;
    }
  });

  // Sortable table headers
  contentEl.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (!th) return;
    const sec = contentEl.querySelector(".view");
    const vk = sec ? sec.dataset.view : state.view;
    const st = state.filters[vk] = state.filters[vk] || {};
    if (st.sortKey === th.dataset.sort) st.sortDir = st.sortDir === "asc" ? "desc" : "asc";
    else { st.sortKey = th.dataset.sort; st.sortDir = "asc"; }
    rerenderCurrent();
  });

  // Search input (debounced)
  document.body.addEventListener("input", (e) => {
    const inp = e.target.closest("[data-search]");
    if (!inp) return;
    const vk = inp.dataset.viewkey;
    const st = state.filters[vk] = state.filters[vk] || {};
    st.search = inp.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => { st.page = 1; rerenderCurrent(); }, 300);
  });

  // Filter select
  document.body.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-filter]");
    if (!sel) return;
    const vk = sel.dataset.viewkey;
    const st = state.filters[vk] = state.filters[vk] || {};
    st[sel.dataset.filter] = sel.value;
    st.page = 1;
    rerenderCurrent();
  });

  // Date filter
  document.body.addEventListener("change", (e) => {
    const dateFrom = e.target.closest("[data-date-from]");
    const dateTo = e.target.closest("[data-date-to]");
    if (!dateFrom && !dateTo) return;
    const input = dateFrom || dateTo;
    const vk = input.dataset.viewkey;
    const st = state.filters[vk] = state.filters[vk] || {};
    if (dateFrom) st.dateFrom = dateFrom.value;
    if (dateTo) st.dateTo = dateTo.value;
    st.page = 1;
    rerenderCurrent();
  });

  // Clear dates button
  document.body.addEventListener("click", (e) => {
    const clearBtn = e.target.closest("[data-clear-dates]");
    if (!clearBtn) return;
    const vk = clearBtn.dataset.viewkey;
    const st = state.filters[vk] = state.filters[vk] || {};
    delete st.dateFrom;
    delete st.dateTo;
    st.page = 1;
    rerenderCurrent();
  });

  // AUTH GUARD — the real entry point.
  onAuthStateChanged(auth, async (user) => {
    if (state.redirecting) return;
    if (!user) { redirectToLogin(); return; }          // not signed in → login
    state.user = user;
    state.authed = true;
    try {
      state.profile = await fetchUserProfile(user);     // calls Cloudflare Worker (mocked for now)
      if (!ALLOWED_ROLES.includes(state.profile.role)) { showDenied(); return; }
      boot();                                           // role allowed → render dashboard
    } catch (err) {
      console.warn("[RetailFlow] auth guard error:", err);
      showDenied();
    }
  });
}

/* Export sales as PDF using browser print */
function exportSalesPdf() {
  const p = state.profile || {};
  const st = state.filters.sales || {};
  let list = db.sales || [];
  // Apply current filters
  if (st.method) list = list.filter((s) => s.method === st.method);
  if (st.status) list = list.filter((s) => s.status === st.status);
  if (st.dateFrom) { const from = new Date(st.dateFrom + 'T00:00:00'); list = list.filter((s) => new Date(s.date || s.created_at) >= from); }
  if (st.dateTo) { const to = new Date(st.dateTo + 'T23:59:59'); list = list.filter((s) => new Date(s.date || s.created_at) <= to); }
  if (st.search) {
    const q = st.search.toLowerCase();
    list = list.filter((s) => (s.id || '').toLowerCase().includes(q) || (s.customer || '').toLowerCase().includes(q) || (s.cashier || '').toLowerCase().includes(q));
  }
  const n2 = (v) => (Number(v) || 0).toFixed(2);
  const totalAmount = list.reduce((sum, s) => sum + saleTotal(s), 0);
  const totalSavings = list.reduce((sum, s) => sum + saleSavings(s), 0);
  const dateRange = (st.dateFrom || 'All') + ' to ' + (st.dateTo || 'All');
  const rows = list.map((s) =>
    '<tr><td>' + esc(s.receiptNumber || s.id) + '</td>'
    + '<td>' + esc(fmtDate(s.date || s.created_at)) + '</td>'
    + '<td>' + esc(s.customer || 'Walk-in') + '</td>'
    + '<td>' + esc(s.cashier || '—') + '</td>'
    + '<td style="text-align:right">' + n2(saleTotal(s)) + '</td>'
    + '<td style="text-align:right">' + (saleSavings(s) > 0 ? '- ' + n2(saleSavings(s)) : '—') + '</td>'
    + '<td>' + esc(s.method || 'Cash') + '</td>'
    + '<td>' + esc(s.status || 'Completed') + '</td></tr>'
  ).join('');
  const html = '<!DOCTYPE html><html><head><title>Sales Report</title>'
    + '<style>body{font-family:Arial,sans-serif;font-size:12px;color:#333;margin:20px;}'
    + 'h1{font-size:18px;margin-bottom:4px;}'
    + '.meta{color:#666;font-size:11px;margin-bottom:16px;}'
    + 'table{width:100%;border-collapse:collapse;margin-top:16px;}'
    + 'th,td{border:1px solid #ddd;padding:8px;text-align:left;}'
    + 'th{background:#f5f5f5;font-weight:600;font-size:11px;}'
    + '.total-row{font-weight:bold;background:#f9f9f9;}'
    + '.footer{margin-top:20px;font-size:10px;color:#999;text-align:center;}</style></head><body>'
    + '<h1>Sales Report</h1>'
    + '<div class="meta">Business: ' + esc((state.business && state.business.name) || 'RetailFlow') + '<br>'
    + 'Date Range: ' + esc(dateRange) + '<br>'
    + 'Generated: ' + esc(new Date().toLocaleString()) + '<br>'
    + 'Total Transactions: ' + list.length + '</div>'
    + '<table><thead><tr><th>Receipt</th><th>Date</th><th>Customer</th><th>Cashier</th>'
    + '<th style="text-align:right">Amount</th><th style="text-align:right">Savings</th>'
    + '<th>Method</th><th>Status</th></tr></thead><tbody>'
    + rows
    + '<tr class="total-row"><td colspan="4">Total</td>'
    + '<td style="text-align:right"><strong>' + n2(totalAmount) + '</strong></td>'
    + '<td style="text-align:right"><strong>' + (totalSavings > 0 ? '- ' + n2(totalSavings) : '—') + '</strong></td>'
    + '<td colspan="2"></td></tr>'
    + '</tbody></table>'
    + '<div class="footer">Powered by Prince Alex Digital - 0717 384 875</div>'
    + '</body></html>';
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => win.print(), 500);
  } else {
    showToast("error", "Popup blocked", "Please allow popups to export PDF.");
  }
}

/* INIT complete — boot() above is invoked by the auth guard. */

window.addEventListener("error", (e) => {
  console.error("[RetailFlow] runtime error:", e.message);
});

window.addEventListener("unhandledrejection", (e) => {
  const err = e && e.reason;
  console.warn("[RetailFlow] unhandled rejection:", err);
  if (err && err.message && /not signed in|401|403/.test(String(err.message + (err.status || "")))) {
    showToast("error", "Session expired", "Please sign in again.");
  }
});

window.__retailflow = { state, renderViews, rerenderCurrent };
initApp();

/*__C7C__*/