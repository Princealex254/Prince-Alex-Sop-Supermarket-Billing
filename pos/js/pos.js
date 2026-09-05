/* ==================================================================
   RetailFlow POS — pos/js/pos.js
   --------------------------------------------------------------
   The RetailFlow point of sale (pos/index.html).

   Modules (kept small and focused so the sales engine stays
   testable and future modules can plug in without rewrites):
     api        — authenticated Cloudflare Worker client
     auth       — Firebase session + D1 profile
     context    — business / branch / settings
     products   — load-once catalogue, search, barcode
     cart       — in-memory sale lines + totals
     customers  — search / attach / create
     checkout   — payment capture
     sales      — submission + history
     receipts   — render / print / download / share
     ui         — toasts, modals, views, loading states

   SECURITY MODEL
     The frontend only decides what UI to show. Every value that
     matters (price, stock, totals, discount, business/branch,
     cashier) is re-validated by the Cloudflare Worker inside
     POST /sales before anything is written to D1.
   ================================================================== */

import { auth, onAuthStateChanged, signOut } from "../../firebase/firebase-config.js";
import { typeDef, normalizeTypeCode, businessLabels, modulesForBusiness, receiptFooterFor } from "../../js/business-types.js";
import { localDB } from "./offline-store.js";

/* ---------------- Constants ---------------- */
const API_BASE = "https://retailflow-api.princealexdigital.workers.dev";

/* Roles that may open the POS terminal. The Worker enforces the same
   list server-side inside POST /sales — this only gates the UI. */
const POS_ACCESS_ROLES = ["owner", "admin", "store_manager", "cashier", "sales_staff", "waiter"];

/* Roles allowed to apply discounts (mirrors the Worker's canDiscount). */
const DISCOUNT_ROLES = ["owner", "admin", "store_manager"];

/* Roles that may open the Admin Console from the POS. */
const ADMIN_CONSOLE_ROLES = ["owner", "admin", "store_manager"];

/* Roles that see only their own transactions by default. */
const SELF_SALES_ROLES = ["cashier", "sales_staff", "waiter"];

const ROLE_DISPLAY = {
  owner: "Platform Owner", admin: "Business Admin", store_manager: "Store Manager",
  cashier: "Cashier", inventory_manager: "Inventory Manager", accountant: "Accountant",
  waiter: "Waiter", sales_staff: "Sales Staff", custom: "Custom"
};

const DEFAULT_PAYMENT_METHODS = ["Cash", "M-Pesa", "Card"];
const DEFAULT_CURRENCY = "KES";
const MAX_UPLOAD_NOTE = "5 MB";
const SALE_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;
const LS_CATEGORY = "retailflow.pos.category";

/* Business-type labels come from the shared registry (js/business-types.js),
   so every type gets the right catalogue words without hard-coding. */

/* ==================================================================
   OFFLINE CAPABILITY
   ------------------------------------------------------------------
   The POS terminal can keep operating during network outages:
     • IndexedDB (via offline-store.js) caches business data
       (products, customers, settings, branches, recent sales)
       so reads fall back to the local cache when the Worker is
       unreachable.
     • Writes (sales, customer creation) are queued locally and
       replayed automatically when connectivity returns.
     • A service worker caches the app shell (HTML/CSS/JS) so the
       POS even loads without a network connection.
   ================================================================== */

/* Current connectivity state. Mirrors navigator.onLine so the rest of
   the module can stay network-agnostic. */
let isOffline = !navigator.onLine;
let swRegistration = null;

/* Update the topbar offline badge to reflect the current state. */
/* Update the topbar connection light — green when online, red when
   offline. Always visible so the cashier instantly shows connectivity.
   Also shows pending offline sales count when there are queued operations.
   Click the badge to manually trigger sync when online with pending sales. */
function refreshOfflineBadge() {
  const badge = $("offlineBadge");
  if (!badge) return;
  const online = !isOffline;
  const label = badge.querySelector(".net-label");
  const pendingCount = state._offlineSalesCount || 0;
  badge.classList.toggle("online", online);
  badge.classList.toggle("offline", !online);
  if (label) {
    if (!online) {
      label.textContent = "Offline";
    } else if (pendingCount > 0) {
      label.textContent = pendingCount + " pending";
    } else {
      label.textContent = "Online";
    }
  }
  const statusText = !online ? "Offline" : (pendingCount > 0 ? pendingCount + " sales pending sync — click to sync now" : "Online");
  badge.setAttribute("aria-label", statusText);
  badge.title = statusText;
  /* Make badge clickable to trigger manual sync */
  badge.style.cursor = (online && pendingCount > 0) ? "pointer" : "default";
  badge.onclick = (online && pendingCount > 0) ? () => {
    showToast("info", "Syncing…", "Uploading " + pendingCount + " pending sale" + (pendingCount === 1 ? "" : "s") + "...");
    syncPendingQueue();
  } : null;
}

/* Ensure the service worker is registered (only in production browsers
   that support it). No-op in environments without SW support. */
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register("sw.js");
    /* Immediately register a Background Sync wake-up if any writes are
       queued, so they upload even if the tab isn't in focus. */
    if (swRegistration && swRegistration.sync && "sync" in swRegistration) {
      scheduleBackgroundSync();
    }
    return swRegistration;
  } catch (err) {
    console.warn("[RetailFlow POS] service worker registration failed:", err);
    return null;
  }
}

/* Replay every pending write that was queued while offline. Each queued
   operation is replayed against the Worker; on success it is removed
   from the queue and the local state is reconciled. On failure the
   op stays queued for the next retry. Returns the number of ops that
   were successfully synced (0 if none were attempted/completed). */
async function syncPendingQueue() {
  if (isOffline) return 0;
  if (!state.user) return 0;   /* not authenticated yet — defer until auth resolves */
  let ops;
  try {
    await localDB.ready;
    ops = await localDB.pendingOps();
  } catch (e) { console.warn("[RetailFlow POS] failed to read pending ops:", e); return 0; }
  if (!ops.length) return 0;

  console.log("[RetailFlow POS] syncing " + ops.length + " pending operation(s)...");
  let syncedCount = 0;
  for (const op of ops) {
    try {
      switch (op.type) {
        case "sale": {
          /* Ensure payload has all required fields for the server. */
          const syncPayload = Object.assign({}, op.payload, {
            items: (op.payload.items || []).map((it) => ({
              productId: it.productId,
              name: it.name,
              quantity: it.quantity,
              price: it.price,
              total: it.total
            }))
          });
          const resp = await apiRequest("/sales", { method: "POST", body: syncPayload, timeoutMs: SALE_TIMEOUT_MS });
          const serverSale = resp.sale || { ...op.payload, id: resp.id || op.payload.id };
          /* Reconcile the local sale with the server-assigned id. */
          if (op.localId && Array.isArray(state.sales)) {
            const idx = state.sales.findIndex((s) => s._localId === op.localId);
            if (idx >= 0) { state.sales[idx] = Object.assign({}, state.sales[idx], serverSale, { _localId: op.localId, _synced: true }); }
          }
          break;
        }
        case "customer": {
          await apiRequest("/customers", { method: "POST", body: op.payload });
          break;
        }
      }
      await localDB.removeOp(op.id);
      syncedCount++;
      if (state._offlineSalesCount) state._offlineSalesCount = Math.max(0, state._offlineSalesCount - 1);
      console.log("[RetailFlow POS] synced op " + op.id + " (" + op.type + ")");
    } catch (err) {
      /* Network / timeout / not-yet-authenticated — keep the op queued and
         try again later. Use continue (not break) so other ops still get attempted. */
      if (!err || err.kind === "network" || err.kind === "timeout" || err.status === 0 || err.status === undefined) {
        console.warn("[RetailFlow POS] op " + op.id + " failed (will retry):", err && err.message);
        continue;
      }
      /* A real HTTP application rejection (4xx/5xx status) means the op
         won't ever succeed as-is — drop it so it doesn't retry forever. */
      console.warn("[RetailFlow POS] dropping pending op (HTTP error):", err.message);
      await localDB.removeOp(op.id);
    }
  }
  /* Refresh the sales view after sync so server-confirmed ids appear. */
  if (state.salesLoaded && typeof renderSales === "function") {
    try { renderSales(); } catch (e) { /* sales view not ready yet */ }
  }
  /* Persist updated sales history back to the offline cache. */
  if (state.sales && state.sales.length) {
    try { localDB.set("sales", state.sales); } catch (e) {}
  }
  if (syncedCount) {
    showToast("success", "Synced", syncedCount + " offline sale" + (syncedCount === 1 ? "" : "s") + " synced to the server.");
  }
  /* Update the badge to reflect the new pending count */
  refreshOfflineBadge();
  return syncedCount;
}

/* Ask the browser to wake sync even in the background (if Background Sync
   is supported). The service worker relays the signal back to this page. */
function scheduleBackgroundSync() {
  try {
    if (swRegistration && swRegistration.sync && "sync" in swRegistration) {
      swRegistration.sync.register("retailflow-sync-pending");
    }
  } catch (e) { /* background sync unavailable — the online/focus listeners handle it */ }
}

/* Fire when connectivity changes. Updates the light and, when back online,
   drains the pending write queue immediately (online event + focus +
   service-worker Background Sync message all lead here). */
function initOffline() {
  window.addEventListener("online", () => {
    isOffline = false;
    refreshOfflineBadge();
    showToast("success", "Back online", "Syncing your offline changes…");
    syncPendingQueue();
    scheduleBackgroundSync();
  });
  window.addEventListener("offline", () => {
    isOffline = true;
    refreshOfflineBadge();
    showToast("warning", "You are offline", "Sales will be saved locally and synced when you're back online.");
  });
  /* Re-sync whenever the tab regains focus (covers flaky networks where
     the online event fired while the tab was idle). */
  window.addEventListener("focus", () => {
    if (!isOffline) syncPendingQueue();
  });
  window.addEventListener("pageshow", () => {
    if (!isOffline) syncPendingQueue();
  });
  /* Service worker relays a Background Sync wake-up (SYNC_PENDING). */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e && e.data && e.data.type === "SYNC_PENDING") {
        scheduleBackgroundSync();
        syncPendingQueue();
      }
    });
  }
  /* Periodic sync every 30 seconds as a safety net for flaky networks
     where the online event may not fire reliably. */
  setInterval(() => {
    if (!isOffline && state.user) {
      syncPendingQueue();
    }
  }, 30000);
  refreshOfflineBadge();
}


/* ---------------- State ---------------- */
const state = {
  user: null,
  profile: null,          // D1 user { id, name, email, role, businessId, branchId }
  business: null,         // businesses row for the active context
  branches: [],           // branches of the active business
  branchId: null,         // active branch
  settings: null,         // D1 settings row (normalised)
  products: [],           // full catalogue (loaded once)
  categories: [],
  activeCategory: "All",
  search: "",
  cart: [],
  customer: null,         // attached customer row or null (walk-in)
  customers: [],
  discount: { type: "amount", value: 0 },
  view: "pos",
  sales: [],
  salesLoaded: false,
  refunds: [],            // refund requests for the sales view (GET /refunds)
  submitting: false,
  clientRequestId: null,  // reserved for future idempotency support
  lastSale: null,
  loadingProducts: false,
  modules: [],                          // enabled module ids (business-types registry)
  labels: { product: "Products", cart: "Cart" },   // catalogue words for this type
  mpesa: null,                          // safe M-Pesa config metadata from the Worker
  mpesaTxn: null                        // in-flight M-Pesa transaction { id, saleId, timer }
};

/* ---------------- Tiny DOM + format helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const currency = () => (state.business && state.business.currency) || DEFAULT_CURRENCY;
function money(v) {
  const n = Number(v) || 0;
  return currency() + " " + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/* Client-side Kenyan phone normaliser (worker re-validates).
   Mirrors worker/daraja.js → normalizeKenyanPhone so the UI can
   flag invalid numbers before the request. */
function normalizeKenyanPhone(input) {
  if (input == null) return "";
  let digits = String(input).replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!/^\d{9,12}$/.test(digits)) return "";
  if (digits.length === 12 && digits.startsWith("254")) {
    digits = digits.substring(3);
  } else if (digits.length === 9) {
    digits = "0" + digits;
  } else if (digits.length !== 10 || !digits.startsWith("0")) {
    return "";
  }
  if (!/^0[71]/.test(digits)) return "";
  return "254" + digits.substring(1);
}
function maskPhone(input) {
  const s = String(input == null ? "" : input);
  if (s.length < 6) return "••••";
  return s.slice(0, -3).replace(/[0-9]/g, "•") + s.slice(-3);
}
function initials(name) {
  return String(name || "?").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms);
  };
}
function newRequestId() {
  if (window.crypto && crypto.randomUUID) return "req_" + crypto.randomUUID();
  return "req_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function can(list) { return list.includes(state.profile && state.profile.role); }

/* ---------------- Toasts ---------------- */
function showToast(type, title, message) {
  const icons = { success: "fa-circle-check", error: "fa-circle-exclamation", info: "fa-circle-info" };
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML =
    '<span class="toast-icon" aria-hidden="true"><i class="fa-solid ' + (icons[type] || icons.info) + '"></i></span>' +
    '<div class="toast-body"><strong></strong><p></p></div>' +
    '<button type="button" class="toast-x" aria-label="Dismiss">✕</button>';
  el.querySelector(".toast-body strong").textContent = title;
  el.querySelector(".toast-body p").textContent = message || "";
  $("toastStack").appendChild(el);
  let closing = false;
  const dismiss = () => {
    if (closing) return;
    closing = true;
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove());
  };
  el.querySelector(".toast-x").addEventListener("click", dismiss);
  setTimeout(dismiss, type === "error" ? 6000 : 3800);
}

/* ---------------- Modal manager ---------------- */
const modalEsc = (e) => { if (e.key === "Escape") closeModal(); };
function openModal(html, opts) {
  const root = $("modalRoot");
  root.innerHTML = '<div class="modal-overlay"><div class="modal-card" role="dialog" aria-modal="true">' + html + "</div></div>";
  document.body.style.overflow = "hidden";
  root.querySelector(".modal-overlay").addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget && !(opts && opts.sticky)) closeModal();
  });
  root.querySelectorAll("[data-modal-close]").forEach((b) => b.addEventListener("click", closeModal));
  document.addEventListener("keydown", modalEsc);
  const first = root.querySelector("[data-focus]") || root.querySelector("input,select,textarea");
  if (first) setTimeout(() => first.focus(), 60);
  return root.querySelector(".modal-card");
}
function closeModal() {
  $("modalRoot").innerHTML = "";
  document.body.style.overflow = "";
  document.removeEventListener("keydown", modalEsc);
}
function modalShell(title, sub, bodyHtml, footHtml) {
  return '<div class="modal-head"><div><h3>' + esc(title) + "</h3>" +
    (sub ? "<p>" + esc(sub) + "</p>" : "") + "</div>" +
    '<button type="button" class="modal-close" data-modal-close aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>' +
    '<div class="modal-body">' + bodyHtml + "</div>" +
    (footHtml ? '<div class="modal-foot">' + footHtml + "</div>" : "");
}

/* ---------------- Barcode Scanner Detector ---------------- */
/* Detects USB/Bluetooth barcode scanners by their rapid input pattern.
   Scanners send characters within ~10-30ms each, humans type >100ms.
   On scan end, fires onScan(barcode) with the decoded value. */
const barcodeScanner = (() => {
  let buffer = "";
  let lastKeyTime = 0;
  let timer = null;
  const SCAN_GAP_MS = 80;       // max ms between chars for scanner input
  const SCAN_END_MS = 120;      // ms of silence that ends a scan
  let onScanCallback = null;

  function isLikelyScanner(now, char) {
    // Scanners send only printable chars; fast timing
    const delta = now - lastKeyTime;
    return delta > 0 && delta < SCAN_GAP_MS && char.length === 1 && /[\w\-.\/]/.test(char);
  }

  function indicateScan() {
    const el = document.getElementById("scannerStatus");
    if (el) {
      el.classList.add("is-scanning");
      setTimeout(() => el.classList.remove("is-scanning"), 400);
    }
  }

  function flush() {
    if (buffer.length >= 4 && onScanCallback) {
      indicateScan();
      onScanCallback(buffer);
    }
    buffer = "";
    timer = null;
  }

  function onKeyDown(e) {
    const now = Date.now();

    // Enter key may signal end of scan
    if (e.key === "Enter") {
      if (buffer.length >= 4 && onScanCallback) {
        e.preventDefault();
        e.stopPropagation();
        flush();
        return;
      }
      return; // let normal Enter handling proceed
    }

    // Ignore modifier keys, function keys, etc.
    if (e.key.length !== 1) return;

    // Detect scanner pattern
    if (isLikelyScanner(now, e.key)) {
      buffer += e.key;
      lastKeyTime = now;

      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SCAN_END_MS);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Human typing - reset scanner buffer
    buffer = "";
    lastKeyTime = now;
  }

  function attach(callback) {
    onScanCallback = callback;
    document.addEventListener("keydown", onKeyDown, true); // capture phase
  }

  function detach() {
    document.removeEventListener("keydown", onKeyDown, true);
    onScanCallback = null;
    buffer = "";
    if (timer) clearTimeout(timer);
  }

  return { attach, detach };
})();

/* ---------------- Confirmation dialog ---------------- */
function showConfirmDialog({ title, message, confirmText, cancelText, onConfirm }) {
  const body = '<p style="margin:0;font-size:0.92rem;color:var(--ink-soft);line-height:1.5;">' + esc(message) + "</p>";
  const footer =
    '<button type="button" class="btn btn-ghost" id="confirmCancel">' + esc(cancelText || "Cancel") + "</button>" +
    '<button type="button" class="btn btn-primary" id="confirmOk"><i class="fa-solid fa-check" aria-hidden="true"></i> ' + esc(confirmText || "Confirm") + "</button>";
  openModal(modalShell(title, null, body, footer), { sticky: true });
  const cancelBtn = $("confirmCancel");
  const okBtn = $("confirmOk");
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  if (okBtn) okBtn.addEventListener("click", () => { closeModal(); if (onConfirm) onConfirm(); });
}

/* ---------------- API layer ---------------- */
async function apiToken() {
  if (!state.user) throw new Error("Not signed in");
  /* Prefer a fresh token online; when offline (forced refresh fails),
     fall back to the cached ID token so queued operations still carry
     the user's identity. Firebase persists the session in IndexedDB. */
  try {
    return await state.user.getIdToken(true);
  } catch (e) {
    try {
      return await state.user.getIdToken();
    } catch (e2) {
      const err = new Error("Unable to authenticate while offline.");
      err.kind = "network";
      throw err;
    }
  }
}

/* Authenticated Worker request with timeout + friendly error mapping.
   401 → back to login. Network/timeout → clear offline message.
   Raw backend errors are logged for support, never shown raw to the cashier. */
async function apiRequest(path, options = {}) {
  const token = await apiToken();
  const timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: options.method || "GET",
      signal: controller.signal,
      headers: Object.assign(
        { Authorization: "Bearer " + token },
        options.body !== undefined ? { "Content-Type": "application/json" } : {},
        options.headers || {}
      ),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      const e = new Error("The server took too long to respond. Please check your internet connection and try again.");
      e.kind = "timeout";
      throw e;
    }
    const e = new Error("Unable to connect to the RetailFlow server. Please check your internet connection.");
    e.kind = "network";
    throw e;
  }
  clearTimeout(timer);

  if (res.status === 401) {
    try { await signOut(auth); } catch (e) { /* ignore */ }
    window.location.assign("/login/index.html");
    throw new Error("Session expired");
  }

  let data = null;
  try { data = await res.json(); } catch (e) { }
  if (!res.ok) {
    console.warn("[RetailFlow POS] API failed:", options.method || "GET", path, res.status, data);
    let msg;
    switch (res.status) {
      case 403: msg = "You do not have permission to perform this action."; break;
      case 409: msg = "This record changed while you were working. Please review and try again."; break;
      case 422: msg = (data && data.error) || "The request could not be processed."; break;
      case 500: msg = "Something went wrong on our side. Please try again."; break;
      default:  msg = (data && data.error) || ("Request failed (" + res.status + ")");
    }
    if ((res.status === 403 || res.status === 404) && data && data.error) msg = data.error;
    const e = new Error(msg);
    e.status = res.status;
    e.raw = data;
    throw e;
  }
  return data || {};
}

/* Endpoint wrappers — the only place URLs are built. */
const api = {
  profile: () => apiRequest("/auth/profile"),
  businesses: () => apiRequest("/businesses"),
  branches: (businessId) => apiRequest("/branches?businessId=" + encodeURIComponent(businessId)),
  settings: () => apiRequest("/settings" + (state.profile.role === "owner" && state.business ? "?businessId=" + encodeURIComponent(state.business.id) : "")),
  products: () => {
    const q = new URLSearchParams();
    if (state.profile.role === "owner" && state.business) q.set("businessId", state.business.id);
    if (state.branchId) q.set("branchId", state.branchId);
    const qs = q.toString();
    return apiRequest("/products" + (qs ? "?" + qs : ""));
  },
  customers: () => {
    const q = new URLSearchParams();
    if (state.profile.role === "owner" && state.business) q.set("businessId", state.business.id);
    const qs = q.toString();
    return apiRequest("/customers" + (qs ? "?" + qs : ""));
  },
  createCustomer: (body) => apiRequest("/customers", { method: "POST", body }),
  createSale: (body) => apiRequest("/sales", { method: "POST", body, timeoutMs: SALE_TIMEOUT_MS }),
  sales: () => {
    const q = new URLSearchParams();
    if (state.profile.role === "owner" && state.business) q.set("businessId", state.business.id);
    if (state.branchId) q.set("branchId", state.branchId);
    const qs = q.toString();
    return apiRequest("/sales" + (qs ? "?" + qs : ""));
  },
  /* Refund requests — cashiers submit, owner/admin/store_manager decide. */
  refunds: () => {
    const q = new URLSearchParams();
    if (state.profile.role === "owner" && state.business) q.set("businessId", state.business.id);
    if (state.branchId) q.set("branchId", state.branchId);
    const qs = q.toString();
    return apiRequest("/refunds" + (qs ? "?" + qs : ""));
  },
  createRefund: (payload) => apiRequest("/refunds", { method: "POST", body: payload }),
  decideRefund: (id, payload) => apiRequest("/refunds/" + encodeURIComponent(id), { method: "PUT", body: payload }),
  /* M-Pesa Daraja — all requests stay on the RetailFlow Worker. */
  mpesaConfig: () => {
    const q = new URLSearchParams();
    if (state.profile.role === "owner" && state.business) q.set("businessId", state.business.id);
    const qs = q.toString();
    return apiRequest("/mpesa/config" + (qs ? "?" + qs : ""));
  },
  mpesaStkPush: (body) => apiRequest("/mpesa/stkpush", { method: "POST", body, timeoutMs: 30000 }),
  mpesaMarkPaid: (body) => apiRequest("/mpesa/mark-paid", { method: "POST", body, timeoutMs: SALE_TIMEOUT_MS }),
  mpesaStatus: (transactionId) => apiRequest("/mpesa/status/" + encodeURIComponent(transactionId)),
  mpesaCancel: (transactionId) => apiRequest("/mpesa/transactions/" + encodeURIComponent(transactionId) + "/cancel", { method: "POST", body: {} })
};

/* Normalise a D1 product row into the shape the POS uses. */
function normProduct(r) {
  return {
    id: r.id,
    name: r.name,
    sku: r.sku || "",
    barcode: r.barcode || "",
    category: r.category || "",
    brand: r.brand || "",
    cost: Number(r.cost_price || 0),
    price: Number(r.selling_price || 0),
    offerPrice: Number(r.offer_price || 0),
    stock: Number(r.stock || 0),
    reorderLevel: Number(r.reorder_level || 0),
    unit: r.unit || "pcs",
    tax: !!r.tax,
    status: r.status || "Active",
    image: r.image || "",
    branchId: r.branch_id || null
  };
}

/* Normalise a D1 sale row into the shape the POS uses. GET /sales
   returns raw snake_case columns (receipt_number, payment_method,
   cashier_id, ...) with items stored as JSON text — without this the
   Sales view reads camelCase fields that do not exist: "My sales only"
   filters out every row, receipts show raw ids, and opening a receipt
   from history crashes on string items. Same idea as normProduct
   above and the owner console's FIELD_MAP.sale. */
function normSale(r) {
  let items = r.items;
  if (typeof items === "string") { try { items = JSON.parse(items); } catch (e) { items = []; } }
  if (!Array.isArray(items)) items = [];
  return {
    id: r.id,
    receiptNumber: r.receipt_number || r.receiptNumber || r.id,
    businessId: r.business_id || r.businessId || null,
    branchId: r.branch_id || r.branchId || null,
    cashierId: r.cashier_id || r.cashierId || null,
    cashierName: r.cashier_name || r.cashierName || "",
    customerId: r.customer_id || r.customerId || null,
    customerName: r.customer_name || r.customerName || "",
    items: items,
    subtotal: Number(r.subtotal || 0),
    tax: Number(r.tax || 0),
    discount: Number(r.discount || 0),
    total: Number(r.total || 0),
    amount: Number(r.amount || r.total || 0),
    change: Number(r.change_amount || r.change || 0),
    paymentMethod: r.payment_method || r.paymentMethod || "Cash",
    status: r.status || "Completed",
    notes: r.notes || "",
    date: r.date || r.created_at || null,
    createdAt: r.created_at || null,
    mpesaReceiptNumber: r.mpesa_receipt_number || r.mpesaReceiptNumber || ""
  };
}

/* ---------------- Boot + auth guard ---------------- */
/* ---------------- Boot + auth guard ---------------- */
function showDenied(message) {
  const loadEl = $("appLoading");
  if (loadEl) loadEl.classList.add("is-hidden");
  if (message && $("deniedMessage")) $("deniedMessage").textContent = message;
  const denied = $("deniedScreen");
  if (denied) denied.hidden = false;
  const signOutBtn = $("deniedSignOut");
  if (signOutBtn) signOutBtn.addEventListener("click", () => void doSignOut());
}
function hideLoading() {
  const loadEl = $("appLoading");
  if (loadEl) loadEl.classList.add("is-hidden");
  const shell = $("appShell");
  if (shell) shell.hidden = false;
}

function redirectToLogin() {
  window.location.assign("/login/index.html");
}

async function doSignOut() {
  try { await signOut(auth); } catch (e) { /* ignore */ }
  window.location.assign("/login/index.html");
}

/* The Worker's /auth/profile returns the D1 user (camelCase).
   Online it fetches and caches; offline (or on a network failure) it
   falls back to the cached profile so the terminal can still start. */
async function loadProfile(firebaseUser) {
  let token = "";
  try { token = await firebaseUser.getIdToken(true); } catch (e) { /* offline */ }
  const cachedFallback = async () => {
    try { return await localDB.get("profile"); } catch (e) { return null; }
  };
  if (isOffline) {
    const cached = await cachedFallback();
    if (cached) return cached;
    throw new Error("No cached profile available");
  }
  try {
    const res = await fetch(API_BASE + "/auth/profile", {
      headers: { Authorization: "Bearer " + token }
    });
    let data = {};
    try { data = await res.json(); } catch (e) { }
    if (!res.ok || !data.success) {
      const err = new Error((data && (data.error || data.message)) || "Profile lookup failed");
      err.status = res.status;
      throw err;
    }
    const user = data.user || {};
    try { await localDB.set("profile", user); } catch (e) { }
    return user;
  } catch (err) {
    /* Auth errors always propagate; network errors fall back to cache. */
    if (err && (err.status === 401 || err.status === 403)) throw err;
    const cached = await cachedFallback();
    if (cached) return cached;
    throw err;
  }
}

/* Resolve the active business + branch for this session.
   Owner picks from their businesses; everyone else is scoped by D1.
   Offline (or on a network failure) it falls back to the cached
   business + branches so the terminal can still start and sell. */
async function loadBusinessContext() {
  const p = state.profile;
  let businesses = [];
  try {
    const data = await loadOrCache("businesses", () => api.businesses(), { businesses: [] });
    businesses = data.businesses || [];
  } catch (err) {
    if (err.status !== 404) throw err;
  }

  let business = null;
  if (p.role === "owner") {
    const wanted = p.businessId;
    business = businesses.find((b) => b.id === wanted) || businesses[0] || null;
    state.businesses = businesses;
  } else {
    business = businesses.find((b) => b.id === p.businessId) || null;
    state.businesses = business ? [business] : [];
    if (!business && p.businessId) {
      /* Fall back to a minimal context so the UI still works. */
      business = { id: p.businessId, name: "My Business", currency: DEFAULT_CURRENCY };
    }
  }
  state.business = business;
  if (business) {
    if (!business.typeCode && business.type) business.typeCode = normalizeTypeCode(business.type);
    state.modules = modulesForBusiness(business, { hidePlanned: true });
    state.labels = businessLabels(business);
  } else {
    state.modules = [];
    state.labels = { product: "Products", cart: "Cart" };
  }
  if (!business) {
    showDenied("Your account is not linked to a business yet. Please contact your administrator.");
    throw new Error("no-business");
  }

  /* Branches */
  try {
    const data = await loadOrCache("branches", () => api.branches(business.id), { branches: [] });
    state.branches = data.branches || [];
  } catch (err) {
    /* Cached branches are the best we have; empty is acceptable. */
    try {
      const cached = await localDB.get("branches");
      state.branches = (cached && cached.branches) || (cached || []);
    } catch (e) { state.branches = []; }
  }
  if (p.branchId) {
    state.branchId = p.branchId;
  } else if (state.branches.length) {
    state.branchId = state.branches[0].id;
  } else {
    state.branchId = null;
  }
}

/* Normalised settings with safe fallbacks. */
function applySettings(row) {
  let methods = DEFAULT_PAYMENT_METHODS;
  try {
    const parsed = row && row.payment_methods ? JSON.parse(row.payment_methods) : null;
    if (Array.isArray(parsed) && parsed.length) methods = parsed;
  } catch (e) { /* keep default */ }
  /* Type-aware receipt footer: a custom footer the owner set always wins;
   otherwise fall back to the generic retail text with the type-specific
   message for this business (restaurant → "dining", hotel → "welcome back", …). */
  const GENERIC_RECEIPT_FOOTER = "Thank you for shopping with us!";
  const storedFooter = row && row.receipt_footer ? String(row.receipt_footer).trim() : "";
  const defaultFooter = state.business ? receiptFooterFor(state.business) : GENERIC_RECEIPT_FOOTER;
  state.settings = {
    receiptFormat: (row && row.receipt_format) || "Standard 80mm",
    receiptFooter: (storedFooter && storedFooter !== GENERIC_RECEIPT_FOOTER) ? storedFooter : defaultFooter,
    receiptPrefix: (row && row.receipt_prefix) || "RF",
    receiptNumbering: (row && row.receipt_numbering) || "date-random",
    receiptPadding: row && row.receipt_padding != null ? Number(row.receipt_padding) : 6,
    defaultPayment: (row && row.default_payment) || "Cash",
    refundPassword: (row && row.refund_password) || "",
    enableTax: !!(row && Number(row.enable_tax) === 1),
    taxRate: row && row.tax_rate != null ? Number(row.tax_rate) : 0,
    enableDiscounts: !(row && Number(row.enable_discounts) === 0),
    paymentMethods: methods,
    dateFormat: (row && row.date_format) || "DD/MM/YYYY",
    language: (row && row.language) || "English",
    receiptPaperless: !(row && Number(row.receipt_paperless) === 0),
    barcodeScanner: !!row && Number(row.barcode_scanner) === 1,
    customerDisplay: !!row && Number(row.customer_display) === 1,
    enableEmailNotifications: !(row && Number(row.enable_email_notifications) === 0),
        enableAudit: !(row && Number(row.enable_audit) === 0)
  };
}

/* ==================================================================
   OFFLINE READ/WRITE HELPERS
   ------------------------------------------------------------------
   loadOrCache — try the network; on success cache the response in
   IndexedDB; on network failure fall back to the cached copy.
   cacheWorkspace — snapshot the entire workspace so the next
   offline session has everything it needs.
   ================================================================== */

/** Try `fn()` (a network call); cache its result. On a network/timeout
 *  failure (or when already offline), return the IndexedDB cache for
 *  `key`, or `fallback` if no cache exists. Auth errors (401/403) are
 *  always re-thrown so the caller can redirect to login. */
async function loadOrCache(key, fn, fallback) {
  if (typeof fallback === "undefined") fallback = null;
  if (!isOffline) {
    try {
      const result = await fn();
      if (result !== undefined && result !== null) {
        try { await localDB.set(key, result); } catch (e) { /* storage unavailable — ignore */ }
      }
      return result;
    } catch (err) {
      /* Auth errors must always propagate (401 → re-login). */
      if (err && (err.status === 401 || err.status === 403)) throw err;
      /* Network / timeout / CORS — fall through to cache. */
    }
  }
  /* Offline (or network failed) — serve from cache. */
  try {
    const cached = await localDB.get(key);
    if (cached !== null && cached !== undefined) return cached;
  } catch (e) { /* IndexedDB unavailable — ignore */ }
  return fallback;
}

/** Snapshot the full in-memory workspace into IndexedDB so subsequent
    boots (online or offline) have a complete local copy.
    NOTE: settings, mpesa, products, customers and branches are cached
    by loadOrCache()/loadBusinessContext() in their raw API-response
    format — we must NOT overwrite them here with the normalised state
    objects (the key names are shared and the shapes differ). Only
    profile, business and sales are cached here. */
async function cacheWorkspace() {
  try {
    await localDB.ready;
    if (state.profile) await localDB.set("profile", state.profile);
    if (state.business) await localDB.set("business", state.business);
    if (state.sales && state.sales.length) await localDB.set("sales", state.sales);
    await localDB.set("lastSync", Date.now());
  } catch (e) { /* storage unavailable — offline mode degrades gracefully */ }
}

/* Persist a single sale to the local sales history (for the Sales view
   when offline). Mutates state.sales in place. */
function recordLocalSale(sale) {
  if (!Array.isArray(state.sales)) state.sales = [];
  state.sales.unshift(sale);
  /* Keep the history trimmed to avoid unbounded growth. */
  if (state.sales.length > 200) state.sales = state.sales.slice(0, 200);
}


/* Load everything the POS needs, then reveal the interface.
   Each step uses loadOrCache() so that if the Worker is unreachable
   (network down), the cached copy from IndexedDB is used instead. */
async function loadWorkspace() {
  const msg = document.querySelector(".boot-msg");
  try {
    msg.textContent = isOffline ? "Restoring local data…" : "Loading business settings…";
    /* Settings — cache fallback via loadOrCache */
    const s = await loadOrCache("settings", () => api.settings());
    applySettings(s ? s.settings : null);

    /* MPesa config (optional — may be absent even when online) */
    msg.textContent = "Checking payment options…";
    state.mpesa = null;
    if (!isOffline) {
      try {
        const md = await api.mpesaConfig();
        state.mpesa = (md && md.mpesa) || null;
        if (state.mpesa) try { await localDB.set("mpesa", md); } catch (e) {}
      } catch (e) { state.mpesa = null; }
    } else {
      try {
        const cached = await localDB.get("mpesa");
        state.mpesa = (cached && cached.mpesa) || null;
      } catch (e) { state.mpesa = null; }
    }

    /* Products — the most critical data for selling */
    msg.textContent = "Loading products…";
    state.loadingProducts = true;
    renderCatalog();
    const pd = await loadOrCache("products", () => api.products());
    state.products = ((pd && pd.products) || []).map(normProduct);
    state.loadingProducts = false;
    buildCategories();

    /* Customers (optional) */
    msg.textContent = "Loading customers…";
    const cd = await loadOrCache("customers", () => api.customers(), { customers: [] });
    state.customers = (cd && cd.customers) || [];

    /* When offline and we successfully restored from cache, warn the
       cashier that sales are being held locally. */
    if (isOffline && pd && pd.products && pd.products.length) {
      showToast("info", "Offline mode", "Working offline — sales will be synced when you're back online.");
    }

    renderAll();
    hideLoading();
    startClock();
    /* Snapshot profile/business/branches for future offline boots */
    cacheWorkspace();
    /* Opportunistically drain any queued writes now that we're online
       (covers Worker recovers while navigator.onLine stayed true). */
    if (!isOffline) syncPendingQueue();
  } catch (err) {
    state.loadingProducts = false;
    if (err.status === 401 || err.status === 403) { redirectToLogin(); return; }
    if (isOffline) {
      msg.textContent = "No local data available.";
      showToast("error", "Offline", "No cached data found. Connect to the internet to load your business data.");
      return;
    }
    if (err.kind === "network" || err.kind === "timeout") {
      msg.textContent = err.message;
      showToast("error", "Connection problem", err.message);
      return;
    }
    throw err;
  }
}

function refreshCatalog() {
  state.loadingProducts = true;
  renderCatalog();
  if (isOffline) return; // keep the cached stock — offline sales already adjusted it locally
  api.products()
    .then((pd) => {
      state.products = (pd.products || []).map(normProduct);
      buildCategories();
      renderCatalog();
    })
    .catch((err) => {
      if (!(err && (err.kind === "network" || err.kind === "timeout" || err.status === 0))) {
        showToast("error", "Could not refresh products", err.message);
      }
      /* On network failure keep the current (cached + locally adjusted) stock. */
    })
    .finally(() => {
      state.loadingProducts = false;
      renderCatalog();
    });
}

/* ==================================================================
      PRODUCT CATALOG — load-once catalogue, search, barcode
   ================================================================== */

function buildCategories() {
  const set = new Set();
  state.products.forEach((p) => set.add(p.category || "Uncategorized"));
  state.categories = ["All", ...[...set].sort((a, b) => a.localeCompare(b))];
}

function productMatches(p) {
  if (state.activeCategory && state.activeCategory !== "All") {
    if ((p.category || "Uncategorized") !== state.activeCategory) return false;
  }
  const q = state.search.trim().toLowerCase();
  if (!q) return true;
  return p.name.toLowerCase().includes(q) || (p.sku && p.sku.toLowerCase().includes(q)) ||
    (p.barcode && p.barcode.toLowerCase().includes(q)) || (p.brand && p.brand.toLowerCase().includes(q));
}

function stockBadge(p) {
  if (p.stock <= 0) return '<span class="badge badge-danger">Out of stock</span>';
  if (p.stock <= p.reorderLevel) return '<span class="badge badge-warning">Low: ' + p.stock + '</span>';
  return '<span class="badge badge-neutral">Stock: ' + p.stock + '</span>';
}

function productCard(p) {
  const soldOut = p.stock <= 0;
  const disabled = soldOut ? ' disabled' : '';
  const typeIcon = (state.business && typeDef(state.business.typeCode ?? state.business.type).icon) || "fa-box";
  const img = p.image
    ? '<div class="prod-img"><img src="' + esc(p.image) + '" alt="" loading="lazy"></div>'
    : '<div class="prod-img prod-img-ph"><i class="fa-solid ' + typeIcon + '" aria-hidden="true"></i></div>';
  
  // Offer display logic
  const hasOffer = p.offerPrice > 0 && p.offerPrice < p.price;
  const offerBadge = hasOffer ? '<span class="prod-offer-badge">OFFER</span>' : '';
  const savingsPercent = hasOffer ? Math.round((1 - p.offerPrice / p.price) * 100) : 0;
  const savingsBadge = hasOffer ? '<span class="prod-savings">Save ' + savingsPercent + '%</span>' : '';
  
  const priceDisplay = hasOffer
    ? '<div class="prod-price has-offer"><span class="prod-price-original">' + money(p.price) + '</span><span class="prod-price-offer">' + money(p.offerPrice) + '</span></div>'
    : '<div class="prod-price">' + money(p.price) + '</div>';
  
  return '<button type="button" class="prod-card' + (soldOut ? ' is-out' : '') + (hasOffer ? ' has-offer' : '') + '" data-product="' + esc(p.id) + '" aria-label="Add ' + esc(p.name) + ' to cart"' + disabled + '>' +
    offerBadge + img + '<div class="prod-info"><div class="prod-name">' + esc(p.name) + '</div>' +
    '<div class="prod-meta">' + esc(p.category) + (p.sku ? ' · ' + esc(p.sku) : '') + '</div>' +
    priceDisplay + savingsBadge + '<div class="prod-foot">' + stockBadge(p) + '</div></div>' +
    '<span class="prod-add" aria-hidden="true"><i class="fa-solid fa-plus"></i></span></button>';
}

function renderCatalog() {
  const grid = $("productGrid");
  if (!grid) return;
  if (state.loadingProducts) {
    grid.innerHTML = '<div class="grid-loading"><div class="boot-spinner"></div><p>Loading products…</p></div>';
    return;
  }
  const list = state.products.filter(productMatches);
  if (!list.length) {
    grid.innerHTML = '<div class="empty-state"><i class="fa-solid fa-box-open" aria-hidden="true"></i><p>' +
      (state.search ? 'No products match “' + esc(state.search) + '”.' : 'No products available.') + '</p>' +
      (state.search ? '<small>Try a different term or clear the search.</small>' : '<small>Add products from Inventory.</small>') + '</div>';
    return;
  }
  grid.innerHTML = list.map(productCard).join("");
}

function renderCategories() {
  const bar = $("categoryBar");
  if (!bar) return;
  bar.innerHTML = state.categories.map((c) =>
    '<button type="button" class="cat' + (c === state.activeCategory ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>'
  ).join("");
}

/* ==================================================================
   CART — in-memory sale lines + totals
   ================================================================== */

function findProduct(query) {
  if (!query) return null;
  const q = String(query).trim().toLowerCase();
  return state.products.find((p) =>
    (p.barcode && String(p.barcode).toLowerCase() === q) || (p.sku && String(p.sku).toLowerCase() === q)
  ) || null;
}

function addToCart(p) {
  if (!p) return;
  const existing = state.cart.find((l) => l.productId === p.id);
  const maxQty = p.stock;
  // Use offer price if available
  const effectivePrice = (p.offerPrice > 0 && p.offerPrice < p.price) ? p.offerPrice : p.price;
  const hasOffer = effectivePrice < p.price;
  const savings = hasOffer ? round2(p.price - effectivePrice) : 0;
  
  if (existing) {
    if (existing.quantity >= maxQty) { showToast("info", "Stock limit", "Only " + maxQty + " of " + p.name + " available."); return; }
    existing.quantity += 1;
    existing.total = round2(existing.quantity * existing.price);
  } else {
    if (p.stock <= 0) { showToast("error", "Out of stock", p.name + " is not available for sale."); return; }
    state.cart.push({ productId: p.id, name: p.name, sku: p.sku, price: effectivePrice, originalPrice: p.price, quantity: 1, tax: p.tax, total: round2(effectivePrice), hasOffer, savings });
  }
  renderCart();
}

function updateCartQty(productId, delta) {
  const line = state.cart.find((l) => l.productId === productId);
  if (!line) return;
  const p = state.products.find((x) => x.id === productId);
  const maxQty = p ? p.stock : line.quantity;
  const next = line.quantity + delta;
  if (next > maxQty) { if (delta > 0) showToast("info", "Stock limit", "Only " + maxQty + " available."); return; }
  if (next <= 0) return removeFromCart(productId);
  line.quantity = next;
  line.total = round2(next * line.price);
  renderCart();
}

function setCartQty(productId, qty) {
  const line = state.cart.find((l) => l.productId === productId);
  if (!line) return;
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q === 0) return removeFromCart(productId);
  const p = state.products.find((x) => x.id === productId);
  const maxQty = p ? p.stock : q;
  line.quantity = Math.min(q, maxQty);
  line.total = round2(line.quantity * line.price);
  renderCart();
}

function removeFromCart(productId) { state.cart = state.cart.filter((l) => l.productId !== productId); renderCart(); }

function clearCart() {
  if (!state.cart.length) return;
  state.cart = [];
  state.customer = null;
  if ($("customerName")) $("customerName").textContent = "Walk-in Customer";
  renderCart();
}

function cartSubtotal() { return round2(state.cart.reduce((s, l) => s + l.total, 0)); }
function cartItemCount() { return state.cart.reduce((s, l) => s + l.quantity, 0); }

function calcDiscount(subtotal) {
  const raw = Number(($("discountInput") || {}).value);
  if (!state.settings || !state.settings.enableDiscounts || !can(DISCOUNT_ROLES) || isNaN(raw) || raw <= 0) return 0;
  let d = raw;
  const isPct = $("discountTypeBtn") && $("discountTypeBtn").dataset.pct === "1";
  if (isPct) d = round2(subtotal * (raw / 100));
  return Math.min(d, subtotal);
}

function calcTaxable(subtotal, discount) {
  if (!state.settings || !state.settings.enableTax) return 0;
  const rate = Number(state.settings.taxRate) || 0;
  if (rate <= 0) return 0;
  // Tax is INCLUSIVE: the selling price already includes tax
  // Formula: tax = price - (price / (1 + rate/100))
  // Or equivalently: tax = price * rate / (100 + rate)
  const taxableAmount = subtotal - discount;
  return round2(taxableAmount * rate / (100 + rate));
}

function calcTotals() {
  const subtotal = cartSubtotal();
  const discount = calcDiscount(subtotal);
  const tax = calcTaxable(subtotal, discount);
  // Total remains the same (selling price includes tax)
  // Subtotal shown on receipt = base price (without tax)
  const baseSubtotal = round2(subtotal - tax);
  return { subtotal: baseSubtotal, discount: discount, tax: tax, total: round2(baseSubtotal + tax) };
}

function renderCart() {
  const items = $("cartItems");
  if (!items) return;
  if (!state.cart.length) {
    items.innerHTML = '<div class="cart-empty"><i class="fa-solid fa-basket-shopping" aria-hidden="true"></i>' +
      '<p>Your ' + esc(((state.labels && state.labels.cart) || "Cart").toLowerCase()) + ' is empty.</p><small>Select a product to begin.</small></div>';
  } else {
    items.innerHTML = state.cart.map((l) => {
      const prod = state.products.find((p) => p.id === l.productId) || {};
      const thumb = prod.image ? '<img class="ci-thumb" src="' + esc(prod.image) + '" alt="">'
        : '<span class="ci-thumb ci-thumb-ph"><i class="fa-solid fa-box"></i></span>';
      return '<div class="cart-item" data-product="' + esc(l.productId) + '">' + thumb +
        '<div class="ci-main"><div class="ci-name">' + esc(l.name) + '</div>' +
        '<div class="ci-price">' + money(l.price) + ' × ' + l.quantity + '</div></div>' +
        '<div class="ci-qty"><button type="button" class="qty-btn" data-delta="-1" aria-label="Decrease"><i class="fa-solid fa-minus"></i></button>' +
        '<input type="number" class="qty-input" value="' + l.quantity + '" min="0" aria-label="Quantity">' +
        '<button type="button" class="qty-btn" data-delta="1" aria-label="Increase"><i class="fa-solid fa-plus"></i></button></div>' +
        '<div class="ci-total">' + money(l.total) + '</div>' +
        '<button type="button" class="ci-remove" aria-label="Remove"><i class="fa-solid fa-xmark"></i></button></div>';
    }).join("");
  }
  const t = calcTotals();
  setText("subtotalVal", money(t.subtotal));
  if ($("discountValRow")) $("discountValRow").hidden = !(t.discount > 0);
  if ($("discountVal")) $("discountVal").textContent = money(t.discount);
  if ($("taxValRow")) $("taxValRow").hidden = !(t.tax > 0);
  if ($("taxLabel")) $("taxLabel").textContent = (state.settings && state.settings.enableTax && state.settings.taxRate) ? 'Tax (' + state.settings.taxRate + '%)' : 'Tax';
  if ($("taxVal")) $("taxVal").textContent = money(t.tax);
  setText("totalVal", money(t.total));
  if ($("payBtn")) $("payBtn").disabled = !state.cart.length;
  const fab = $("cartFab");
  if (fab) { fab.hidden = state.cart.length === 0; if ($("fabCount")) $("fabCount").textContent = cartItemCount(); }
}

/* ==================================================================
   CHECKOUT + PAYMENTS
   ================================================================== */

/* Receipt numbering module — generates unique, collision-resistant receipt
   numbers. The format is driven by business settings (Settings → POS → Receipt
   Numbering). Four numbering schemes are supported:

     date-random   RF-20260904-123456  (date + 6-digit random)
     sequential    RF-000001           (zero-padded sequence counter)
     date-cashier  RF-20260904-JD-123  (date + cashier initials + 3-digit seq)
     year-sequential RF-2026-000001    (year + zero-padded sequence)

   Collision avoidance:
     • date-random uses crypto-grade randomness (crypto.getRandomValues when
       available, Date.now() + counter fallback) so the chance of collision
       across many simultaneous cashiers is negligible.
     • sequential uses a persistent counter in localStorage, keyed per
       business, so numbers only advance — never repeat — even across
       browser reloads.
     • date-cashier includes the cashier initials to namespace the sequence,
       so two cashiers can sell simultaneously without clashing.
*/
let _receiptCounter = 0;       // in-memory counter for this session
let _receiptDateKey = "";      // tracks the current day for daily reset

function buildReceiptNumber() {
  const s = state.settings || {};
  const prefix = (s.receiptPrefix || "RF").trim().toUpperCase() || "RF";
  const numbering = s.receiptNumbering || "date-random";
  const padding = Number(s.receiptPadding) || 6;

  const d = new Date();
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const dateStr = "" + y + mo + day;

  // Cashier initials (e.g. "John Doe" → "JD")
  const cashierName = (state.profile && state.profile.name) || "";
  const initials = cashierName.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase().slice(0, 3) || "XX";

  // Crypto-grade random helper (works in all modern browsers)
  function secureRandom(max) {
    if (window.crypto && window.crypto.getRandomValues) {
      const arr = new Uint32Array(1);
      window.crypto.getRandomValues(arr);
      return arr[0] % max;
    }
    return Math.floor(Math.random() * max);
  }

  // Persistent sequential counter in localStorage
  function nextSequential(key) {
    const storeKey = "retailflow_receipt_seq_" + key;
    let current = parseInt(localStorage.getItem(storeKey) || "0", 10) || 0;
    current += 1;
    localStorage.setItem(storeKey, String(current));
    return current;
  }

  switch (numbering) {
    case "sequential": {
      const seq = nextSequential(prefix);
      return prefix + "-" + String(seq).padStart(padding, "0");
    }
    case "year-sequential": {
      const seq = nextSequential(prefix + "_" + y);
      return prefix + "-" + y + "-" + String(seq).padStart(padding, "0");
    }
    case "date-cashier": {
      // Per-cashier daily counter
      const counterKey = prefix + "_" + dateStr + "_" + initials;
      const storeKey = "retailflow_receipt_daily_" + counterKey;
      let count = parseInt(localStorage.getItem(storeKey) || "0", 10) || 0;
      count += 1;
      localStorage.setItem(storeKey, String(count));
      // Also include a random component for extra safety
      const rand = String(secureRandom(900) + 100); // 100-999
      return prefix + "-" + dateStr + "-" + initials + "-" + rand;
    }
    case "date-random":
    default: {
      // Use timestamp component + secure random for collision resistance
      // Format: PREFIX-YYYYMMDD-RANDOM (where random is padded to padding length)
      const rand = String(secureRandom(Math.pow(10, padding) - Math.pow(10, padding - 1)) + Math.pow(10, padding - 1));
      return prefix + "-" + dateStr + "-" + rand;
    }
  }
}

function openCheckout() {
  if (!state.cart.length) return;
  if (!can(POS_ACCESS_ROLES)) { showToast("error", "Access denied", "You do not have permission to complete sales."); return; }
  const t = calcTotals();
  let methods = (state.settings && state.settings.paymentMethods && state.settings.paymentMethods.length)
    ? state.settings.paymentMethods.slice() : DEFAULT_PAYMENT_METHODS.slice();
  /*
   * M-Pesa shows at the POS when the business has configured it via the
   * M-Pesa settings tab. The "enabled" setting only controls whether the
   * "Send Prompt" option is available - Direct Till is always available
   * for configured M-Pesa accounts.
   */
  const mpesaConfigured = !!(state.mpesa && state.mpesa.configured);
  const mpesaEnabled = !!(state.mpesa && state.mpesa.configured && state.mpesa.enabled);
  if (mpesaConfigured && methods.indexOf("M-Pesa") === -1) {
    methods.push("M-Pesa");
  }
  if (!mpesaConfigured) {
    methods = methods.filter((m) => m !== "M-Pesa");
  }
  if (!methods.length) methods = ["Cash"];
  const custName = (state.customer && state.customer.name) ? state.customer.name : "Walk-in Customer";
  const body =
    '<div class="co-summary"><div class="co-summary-row"><span>Customer</span><strong>' + esc(custName) + '</strong></div>' +
    '<div class="co-summary-row"><span>Items</span><strong>' + cartItemCount() + '</strong></div>' +
    '<div class="co-summary-row co-total-row"><span>Total due</span><strong id="coTotal">' + money(t.total) + '</strong></div></div>' +
    '<div class="co-methods" id="coMethods">' + methods.map((m) =>
      '<button type="button" class="co-method' + (m === "M-Pesa" ? ' co-method-mpesa' : '') + '" data-method="' + esc(m) + '"><i class="' + methodIcon(m) + '" aria-hidden="true"></i>' + esc(m) + '</button>'
    ).join("") + '</div>' +
    '<div class="co-payment" id="coPayment"></div>' +
    '<div class="co-actions"><button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="coConfirm" disabled><i class="fa-solid fa-check" aria-hidden="true"></i> Complete sale</button></div>';
  openModal(modalShell("Checkout", "Review the sale and capture payment.", body), { sticky: true });
  state._checkout = { method: methods[0] || "Cash", amountReceived: 0, reference: "", mpesaPhone: "", mpesaReceipt: "", mpesaMode: "prompt", t: t, mpesaAvailable: mpesaEnabled };
  renderPaymentPanel();
  /* Wire modal-level controls exactly once (see wireCheckoutEvents). */
  wireCheckoutEvents();
}

function methodIcon(m) {
  const map = { Cash: "fa-money-bill-wave", "M-Pesa": "fa-mobile-screen-button", Card: "fa-credit-card", Bank: "fa-building-columns", Other: "fa-wallet" };
  return "fa-solid " + (map[m] || "fa-money-bill");
}

function renderPaymentPanel() {
  const c = state._checkout;
  if (!c) return;
  const box = $("coPayment");
  if (!box) return;
  const total = c.t.total;
  let html = '<div class="co-field"><label>Payment method</label><div class="co-method-current">' + esc(c.method) + '</div></div>';
  if (c.method === "Cash") {
    html += '<div class="co-field"><label for="coReceived">Amount received</label>' +
      '<div class="co-amount"><span class="co-cur">' + esc(state.business.currency || DEFAULT_CURRENCY) + '</span>' +
      '<input type="number" id="coReceived" min="0" step="0.01" placeholder="' + total.toFixed(2) + '" value="" inputmode="decimal"></div></div>' +
      '<div class="co-change" id="coChangeRow" hidden><span>Change</span><strong id="coChange">—</strong></div>';
  } else if (c.method === "M-Pesa") {
    const isDirectTill = c.mpesaMode === "direct";
    const stkPushEnabled = !!c.mpesaAvailable;
    html += '<div class="co-field co-mpesa-amount"><label>Amount to request</label>' +
      '<div class="co-amount"><span class="co-cur">' + esc(state.business.currency || DEFAULT_CURRENCY) + '</span>' +
      '<span class="co-fixed">' + total.toFixed(2) + '</span></div></div>';
    /* Only show the toggle if STK Push is enabled. Otherwise, default to Direct Till. */
    if (stkPushEnabled) {
      html += '<div class="co-field"><label>M-Pesa payment type</label>' +
        '<div class="co-mpesa-toggle">' +
        '<button type="button" class="co-mpesa-toggle-btn' + (isDirectTill ? '' : ' is-active') + '" data-mpesa-mode="prompt">' +
        '<i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i> Send Prompt</button>' +
        '<button type="button" class="co-mpesa-toggle-btn' + (isDirectTill ? ' is-active' : '') + '" data-mpesa-mode="direct">' +
        '<i class="fa-solid fa-building-columns" aria-hidden="true"></i> Direct Till</button>' +
        '</div></div>';
    } else {
      /* STK Push disabled — force Direct Till mode and hide the toggle. */
      c.mpesaMode = "direct";
    }
    if (c.mpesaMode === "direct") {
      html += '<div class="co-field"><label for="coMpesaReceipt">M-Pesa receipt number</label>' +
        '<input type="text" id="coMpesaReceipt" placeholder="e.g. QGH4K3V8R9" autocomplete="off" inputmode="text">' +
        '<div class="co-hint">Enter the receipt number from the customer\'s M-Pesa message.</div></div>';
    } else {
      html += '<div class="co-field"><label for="coMpesaPhone">Customer phone number</label>' +
        '<input type="tel" id="coMpesaPhone" placeholder="07XXXXXXXX or 2547XXXXXXXX" autocomplete="off" inputmode="tel">' +
        '<div class="co-hint">An M-Pesa prompt will be sent to this number.</div></div>';
    }
    html += '<div class="co-field" id="coMpesaErr" hidden></div>';
  } else {
    html += '<div class="co-field"><label for="coRef">Reference / Transaction ID</label>' +
      '<input type="text" id="coRef" placeholder="e.g. ABC123XYZ" autocomplete="off"></div>';
  }
  box.innerHTML = html;
  /* Update the confirm button label per method. The button itself is
     created once per modal; only its label/state change here. */
  const confirmBtn = $("coConfirm");
  if (confirmBtn) {
    if (c.method === "M-Pesa") {
      confirmBtn.setAttribute("data-mpesa", "1");
      if (c.mpesaMode === "direct") {
        confirmBtn.innerHTML = '<i class="fa-solid fa-building-columns" aria-hidden="true"></i> Mark Paid (Direct)';
      } else {
        confirmBtn.innerHTML = '<i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i> Send Payment Prompt';
      }
    } else {
      confirmBtn.removeAttribute("data-mpesa");
      confirmBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Complete sale';
    }
  }
  wireCheckoutFields();
  validateCheckout();
}

/* Wire the checkout controls that are created ONCE with the modal
   (payment-method buttons + the Complete-sale button). Called exactly
   once from openCheckout().
   NEVER call this from renderPaymentPanel(): those controls are NOT
   re-rendered when the payment panel updates, so every call would
   stack ANOTHER click listener on the same button — one press of
   "Complete sale" would then run submitSale() N times and create N
   duplicate sales. The re-rendered inputs are wired in
   wireCheckoutFields() instead. */
function wireCheckoutEvents() {
  const c = state._checkout; if (!c) return;
  const methods = $("coMethods");
  if (methods) methods.querySelectorAll(".co-method").forEach((b) =>
    b.addEventListener("click", () => { c.method = b.dataset.method; renderPaymentPanel(); }));
  const confirmBtn = $("coConfirm");
  if (confirmBtn) confirmBtn.addEventListener("click", () => void submitSale());
}

/* Wire the checkout inputs that ARE re-created on every
   renderPaymentPanel() (amount received / payment reference). Safe to
   call repeatedly — each call binds to the fresh elements. */
function wireCheckoutFields() {
  const c = state._checkout; if (!c) return;
  const received = $("coReceived");
  if (received) {
    const onChange = () => {
      c.amountReceived = round2(Math.max(0, parseFloat(received.value) || 0));
      const changeEl = $("coChangeRow");
      if (changeEl) {
        const change = round2(c.amountReceived - c.t.total);
        changeEl.hidden = c.amountReceived <= 0;
        if ($("coChange")) $("coChange").textContent = money(Math.max(0, change));
      }
      validateCheckout();
    };
    received.addEventListener("input", onChange);
    received.addEventListener("change", onChange);
    setTimeout(() => received.focus(), 60);
  }
  const ref = $("coRef");
  if (ref) { c.reference = ref.value; ref.addEventListener("input", () => { c.reference = ref.value.trim(); validateCheckout(); }); }
  const mpesaPhone = $("coMpesaPhone");
  if (mpesaPhone) {
    const onPhoneInput = () => {
      c.mpesaPhone = mpesaPhone.value.trim();
      const errBox = $("coMpesaErr");
      if (errBox) {
        if (c.mpesaPhone && !normalizeKenyanPhone(c.mpesaPhone)) {
          errBox.hidden = false;
          errBox.className = "co-field co-field-error";
          errBox.innerHTML = "Enter a valid Kenyan mobile number.";
        } else {
          errBox.hidden = true;
        }
      }
      validateCheckout();
    };
    mpesaPhone.addEventListener("input", onPhoneInput);
    mpesaPhone.addEventListener("change", onPhoneInput);
    setTimeout(() => mpesaPhone.focus(), 60);
  }
  const mpesaReceipt = $("coMpesaReceipt");
  if (mpesaReceipt) {
    mpesaReceipt.addEventListener("input", () => {
      c.mpesaReceipt = mpesaReceipt.value.trim();
      validateCheckout();
    });
    mpesaReceipt.addEventListener("change", () => {
      c.mpesaReceipt = mpesaReceipt.value.trim();
      validateCheckout();
    });
    setTimeout(() => mpesaReceipt.focus(), 60);
  }
  const mpesaToggleBtns = document.querySelectorAll(".co-mpesa-toggle-btn");
  mpesaToggleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      c.mpesaMode = btn.dataset.mpesaMode;
      renderPaymentPanel();
      wireCheckoutFields();
    });
  });
}

function validateCheckout() {
  const c = state._checkout;
  const btn = $("coConfirm");
  if (!btn || !c) return;
  let ok = false;
  if (c.method === "Cash") {
    // Use epsilon comparison to avoid floating-point precision issues
    const epsilon = 0.001;
    ok = (c.amountReceived + epsilon) >= c.t.total;
  } else if (c.method === "M-Pesa") {
    if (c.mpesaMode === "direct") {
      ok = !!c.mpesaReceipt && c.mpesaReceipt.length >= 5;
    } else {
      ok = !!normalizeKenyanPhone(c.mpesaPhone);
    }
  }
  else ok = true;
  btn.disabled = !ok;
}

/* ==================================================================
   SALES SUBMISSION
   ================================================================== */

async function submitSale() {
  const c = state._checkout;
  if (!c) return;
  /* Re-entrancy guard: one submission at a time. Protects against
     double-taps and any stray duplicate listener — a second call while
     a sale is already in flight returns immediately. */
  if (state._submitting) return;

    /* M-Pesa takes its own async path: the sale is created server-side
     as Pending and only completes when Daraja confirms the payment.
     For direct till payments, we mark the sale as paid immediately.
     M-Pesa requires online connectivity (Safaricom's Daraja API) —
     when offline we block it and fall back to Cash only. */
  if (c.method === "M-Pesa") {
    if (isOffline) {
      showToast("error", "M-Pesa unavailable", "M-Pesa payments require an internet connection. Please use Cash.");
      return;
    }
    if (c.mpesaMode === "direct") {
      await submitDirectMpesaPayment();
    } else {
      await startMpesaPayment();
    }
    return;
  }


  state._submitting = true;
  const t = c.t;
  const payload = {
    businessId: state.business.id,
    branchId: state.branchId || null,
    customerId: state.customer ? state.customer.id : null,
    receiptNumber: buildReceiptNumber(),
    items: state.cart.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, price: round2(l.price), total: round2(l.total) })),
    subtotal: round2(t.subtotal),
    tax: round2(t.tax),
    discount: round2(t.discount),
    total: round2(t.total),
    amount: c.method === "Cash" ? round2(c.amountReceived) : round2(t.total),
    change: c.method === "Cash" ? round2(Math.max(0, c.amountReceived - t.total)) : 0,
    paymentMethod: c.method,
    reference: c.method === "Cash" ? null : (c.reference || null),
    notes: ""
  };
  const btn = $("coConfirm");
  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
  let resp;
  try {
    resp = await api.createSale(payload);
  } catch (err) {
    /* Network failure — queue the sale locally so the cashier can
       keep selling. It will sync automatically when back online. */
    if (err && (err.kind === "network" || err.kind === "timeout" || err.status === 0)) {
      if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
      state._submitting = false;
      await queueOfflineSale(payload);
      return;
    }
    state._submitting = false;
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
    showToast("error", "Sale failed", err.message);
    return;
  }
  if (btn) btn.classList.remove("is-loading");
  const sale = resp.sale || { ...payload, id: resp.id || "sale_" + Date.now(), date: new Date().toISOString(), status: "Completed" };
  state._submitting = false;
  state._checkout = null; /* any late/duplicate call now bails out above */
  state._lastSale = sale;
  closeModal();
  showSaleSuccess(sale);
  state.cart = [];
  state.customer = null;
  refreshCatalog();
  /* Persist the updated product stock + sales history locally */
  cacheWorkspace();
}

/* ------------------------------------------------------------------
   OFFLINE SALE QUEUING
   When the Worker is unreachable, we record the sale locally (with a
   temporary id), decrement in-memory stock so the catalog is accurate
   during the outage, and enqueue a write op for background sync. The
   cashier sees the normal success screen — selling never stops.
   ------------------------------------------------------------------ */
async function queueOfflineSale(payload) {
  const localId = "local_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
  const sale = Object.assign({}, payload, {
    id: localId,
    _localId: localId,
    _synced: false,
    status: "Completed",
    date: new Date().toISOString()
  });

  /* 1. Apply instantly in-memory — the UI must not wait on storage. */
  recordLocalSale(sale);
  decrementLocalStock(payload.items);
  state._offlineSalesCount = (state._offlineSalesCount || 0) + 1;

  /* 2. Show the normal success screen right away. */
  state._submitting = false;
  state._checkout = null;
  state._lastSale = sale;
  closeModal();
  showSaleSuccess(sale);
  state.cart = [];
  state.customer = null;
  showToast("warning", "Saved offline", "This sale is saved locally and will sync when you're back online. (" + state._offlineSalesCount + " pending)");

  /* 3. Defer non-critical UI updates to next frame so the sale shows instantly. */
  requestAnimationFrame(() => {
    refreshCatalog();
  });

  /* 4. Persist durably in the background (fire-and-forget so this method
     and submitSale return immediately): queue the write op and refresh the
     cached products so a reload keeps accurate stock. */
  void (async () => {
    try {
      await localDB.ready;
      await localDB.enqueue({ type: "sale", localId, payload, status: "pending" });
      await persistOfflineStock(payload.items);
      /* If connectivity came back while we were saving, upload right away. */
      if (!isOffline) syncPendingQueue();
    } catch (e) { /* storage unavailable — sale still shows in this session */ }
  })();
}

/* Adjust in-memory product stock after an offline sale. Sync-agnostic and
   non-blocking (no storage I/O in the hot path) so the offline sale shows
   instantly. Mirrors the Worker's stock deduction; the Worker re-validates
   and reconciles on sync. */
function decrementLocalStock(items) {
  for (const item of (items || [])) {
    const idx = state.products.findIndex((p) => p.id === item.productId);
    if (idx >= 0) {
      state.products[idx].stock = Math.max(0, Number(state.products[idx].stock || 0) - Number(item.quantity || 0));
    }
  }
}

/* Persist the local stock decrement into the cached products snapshot so a
   reload during the same outage still reflects the reduced stock. Called
   in the background AFTER the sale UI has already been shown, so it never
   slows the cashier. */
async function persistOfflineStock(items) {
  const cached = await localDB.get("products");
  if (!cached || !Array.isArray(cached.products)) return;
  for (const item of (items || [])) {
    const p = cached.products.find((x) => x.id === (item.productId || item.id));
    if (p && p.stock != null) {
      p.stock = Math.max(0, Number(p.stock || 0) - Number(item.quantity || 0));
    }
  }
  await localDB.set("products", cached);
}

/* ==================================================================
   M-PESA STK PUSH FLOW
   The sale is created server-side as Pending; stock is only deducted
   and the receipt generated once the Daraja callback confirms the
   payment. The POS polls /mpesa/status/:id until a terminal state.
   ================================================================== */

const MPESA_POLL_MS = 3000;
const MPESA_POLL_MAX = 60;        // ~3 minutes of polling
const MPESA_PENDING_MSGS = {
  checking: "Checking payment…",
  timeout: "Payment is still pending. Ask the customer to confirm on their phone, or wait a moment and check again.",
  failed: "Payment could not be confirmed.",
  cancelled: "The customer's payment was cancelled.",
  underpaid: "The customer paid less than the total. Ask a manager to review this transaction."
};

async function startMpesaPayment() {
  const c = state._checkout;
  if (!c || state._submitting) return;
  const phone = normalizeKenyanPhone(c.mpesaPhone);
  if (!phone) {
    showToast("error", "Invalid number", "Enter a valid Kenyan mobile number.");
    return;
  }

  state._submitting = true;
  const t = c.t;
  const payload = {
    businessId: state.business.id,
    branchId: state.branchId || null,
    customerId: state.customer ? state.customer.id : null,
    receiptNumber: buildReceiptNumber(),
    items: state.cart.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, price: round2(l.price), total: round2(l.total) })),
    subtotal: round2(t.subtotal),
    tax: round2(t.tax),
    discount: round2(t.discount),
    total: round2(t.total),
    amount: round2(t.total),
    change: 0,
    paymentMethod: "M-Pesa",
    reference: null,
    notes: ""
  };

  const btn = $("coConfirm");
  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }

  let resp;
  try {
    resp = await api.mpesaStkPush(Object.assign({}, payload, { phone }));
  } catch (err) {
    state._submitting = false;
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
    showToast("error", "M-Pesa", err.message || "Unable to send payment prompt. Please try again.");
    return;
  }

  if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
  state._submitting = false;

  state.mpesaTxn = {
    id: resp.transactionId || resp.transaction_id || null,
    saleId: resp.saleId || resp.sale_id || null,
    checkoutRequestId: resp.checkoutRequestId || resp.checkout_request_id || null,
    phone,
    amount: t.total,
    receiptNumber: payload.receiptNumber,
    attempts: 0,
    timer: null
  };

  renderMpesaPending();
  state.mpesaTxn.timer = setInterval(() => void pollMpesaStatus(), MPESA_POLL_MS);
}

/* ==================================================================
   M-PESA DIRECT TILL PAYMENT
   For customers who pay directly to the till number without needing
   a prompt. The sale is marked as completed immediately with the
   M-Pesa receipt number provided by the cashier.
   ================================================================== */
async function submitDirectMpesaPayment() {
  const c = state._checkout;
  if (!c || state._submitting) return;
  if (!c.mpesaReceipt || c.mpesaReceipt.length < 5) {
    showToast("error", "Invalid receipt", "Enter a valid M-Pesa receipt number.");
    return;
  }

  state._submitting = true;
  const t = c.t;
  const payload = {
    businessId: state.business.id,
    branchId: state.branchId || null,
    customerId: state.customer ? state.customer.id : null,
    receiptNumber: buildReceiptNumber(),
    items: state.cart.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, price: round2(l.price), total: round2(l.total) })),
    subtotal: round2(t.subtotal),
    tax: round2(t.tax),
    discount: round2(t.discount),
    total: round2(t.total),
    amount: round2(t.total),
    change: 0,
    paymentMethod: "M-Pesa",
    mpesaReceipt: c.mpesaReceipt,
    notes: ""
  };

  const btn = $("coConfirm");
  if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }

  let resp;
  try {
    resp = await api.mpesaMarkPaid(payload);
  } catch (err) {
    state._submitting = false;
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
    showToast("error", "M-Pesa", err.message || "Unable to process direct payment. Please try again.");
    return;
  }

  if (btn) btn.classList.remove("is-loading");
  const sale = resp.sale || { ...payload, id: resp.id || "sale_" + Date.now(), date: new Date().toISOString(), status: "Completed" };
  state._submitting = false;
  state._checkout = null;
  state._lastSale = sale;

  closeModal();
  showSaleSuccess(sale);
  state.cart = [];
  state.customer = null;
  refreshCatalog();
}

/* Pending panel — replaces the payment fields inside the open modal. */
function renderMpesaPending() {
  const txn = state.mpesaTxn;
  const c = state._checkout;
  if (!txn || !c) return;
  const box = $("coPayment");
  if (!box) return;
  const pretty = txn.phone.replace(/^(\d{3})(\d{3})(\d{3})(\d{3})$/, "$1 $2 $3 $4");
  box.innerHTML =
    '<div class="co-mpesa-pending">' +
    '<div class="mp-icon"><i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i></div>' +
    '<h3>Payment Prompt Sent</h3>' +
    '<div class="mp-amount">' + money(txn.amount) + '</div>' +
    '<p class="mp-note">A payment request has been sent to:</p>' +
    '<div class="mp-phone">' + esc(pretty) + '</div>' +
    '<p class="mp-note">Ask the customer to complete the payment on their phone.</p>' +
    '<div class="mp-checking"><span class="mp-spinner" aria-hidden="true"></span> ' + MPESA_PENDING_MSGS.checking + '</div>' +
    '<button type="button" class="btn btn-ghost btn-sm mp-cancel" id="mpCancel">Cancel</button>' +
    '</div>';
  const confirmBtn = $("coConfirm");
  if (confirmBtn) confirmBtn.disabled = true;
  const cancelBtn = $("mpCancel");
  if (cancelBtn) cancelBtn.addEventListener("click", () => void cancelMpesaPayment());
}

/* Restore the editable payment panel after a failed attempt. */
function restoreCheckoutPanel() {
  stopMpesaPolling();
  state.mpesaTxn = null;
  renderPaymentPanel();
}

function stopMpesaPolling() {
  const txn = state.mpesaTxn;
  if (txn && txn.timer) { clearInterval(txn.timer); txn.timer = null; }
}

async function pollMpesaStatus() {
  const txn = state.mpesaTxn;
  if (!txn || !txn.id) return;
  txn.attempts += 1;

  let resp;
  try {
    resp = await api.mpesaStatus(txn.id);
  } catch (err) {
    if (txn.attempts >= MPESA_POLL_MAX) {
      showToast("info", "M-Pesa", MPESA_PENDING_MSGS.timeout);
      restoreCheckoutPanel();
    }
    return;
  }

  const status = resp.status || "Pending";

  if (status === "Completed") {
    stopMpesaPolling();
    const sale = resp.sale ? normSale(resp.sale) : null;
    if (!sale) {
      // Fallback — rebuild a displayable sale from the current cart.
      const c = state._checkout;
      const fallback = {
        id: txn.saleId || txn.id,
        receiptNumber: txn.receiptNumber,
        items: state.cart.map((l) => ({ name: l.name, quantity: l.quantity, price: round2(l.price), total: round2(l.total) })),
        subtotal: round2(c ? c.t.subtotal : 0),
        tax: round2(c ? c.t.tax : 0),
        discount: round2(c ? c.t.discount : 0),
        total: txn.amount,
        amount: txn.amount,
        change: 0,
        paymentMethod: "M-Pesa",
        mpesaReceiptNumber: resp.receiptNumber || "",
        status: "Completed",
        date: new Date().toISOString()
      };
      finishMpesaSale(fallback);
      return;
    }
    sale.mpesaReceiptNumber = resp.receiptNumber || sale.mpesaReceiptNumber || "";
    finishMpesaSale(sale);
    return;
  }

  if (status === "Failed") {
    stopMpesaPolling();
    showToast("error", "M-Pesa", MPESA_PENDING_MSGS.failed);
    restoreCheckoutPanel();
    return;
  }

  if (status === "Cancelled") {
    stopMpesaPolling();
    showToast("info", "M-Pesa", MPESA_PENDING_MSGS.cancelled);
    restoreCheckoutPanel();
    return;
  }

  if (status === "Underpaid") {
    stopMpesaPolling();
    showToast("error", "M-Pesa", MPESA_PENDING_MSGS.underpaid);
    restoreCheckoutPanel();
    return;
  }

  if (txn.attempts >= MPESA_POLL_MAX) {
    stopMpesaPolling();
    showToast("info", "M-Pesa", MPESA_PENDING_MSGS.timeout);
    restoreCheckoutPanel();
  }
}

/* Shared completion: close the checkout, show the receipt, clear the
   cart and refresh stock + sales history. */
function finishMpesaSale(sale) {
  state._lastSale = sale;
  state._checkout = null;
  state.mpesaTxn = null;
  closeModal();
  showSaleSuccess(sale);
  state.cart = [];
  state.customer = null;
  refreshCatalog();
  loadSales();
}

async function cancelMpesaPayment() {
  const txn = state.mpesaTxn;
  stopMpesaPolling();
  if (txn && txn.id) {
    try { await api.mpesaCancel(txn.id); } catch (e) { /* non-fatal */ }
  }
  state.mpesaTxn = null;
  renderPaymentPanel();
}

/* ==================================================================
   RECEIPTS — render / print / download / share
   ================================================================== */

function showSaleSuccess(sale) {
  const change = Number(sale.change) || 0;
  const mpesaReceipt = String(sale.mpesaReceiptNumber || "").trim();
  const body =
    '<div class="sale-success"><div class="ss-icon"><i class="fa-solid fa-circle-check" aria-hidden="true"></i></div>' +
    '<h2>Sale Completed</h2><p class="ss-receipt">Receipt #' + esc(sale.receiptNumber || sale.id) + '</p>' +
    '<div class="ss-total"><span>Total</span><strong>' + money(sale.total) + '</strong></div>' +
    '<div class="ss-pay"><span>Payment</span><strong>' + esc(sale.paymentMethod) + '</strong></div>' +
    (mpesaReceipt ? '<div class="ss-pay"><span>M-Pesa Receipt</span><strong class="mono">' + esc(mpesaReceipt) + '</strong></div>' : "") +
    (change > 0 ? '<div class="ss-change"><span>Change</span><strong>' + money(change) + '</strong></div>' : "") +
    '<div class="ss-actions">' +
    '<button type="button" class="btn btn-ghost" id="ssPrint"><i class="fa-solid fa-print" aria-hidden="true"></i> Print</button>' +
    '<button type="button" class="btn btn-ghost" id="ssDownload"><i class="fa-solid fa-download" aria-hidden="true"></i> Download</button>' +
    '<button type="button" class="btn btn-ghost" id="ssShare"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> Share</button>' +
    '<button type="button" class="btn btn-primary" id="ssNew"><i class="fa-solid fa-plus" aria-hidden="true"></i> New Sale</button>' +
    '</div></div>';
  openModal(modalShell("Success", "", body), { sticky: true });
  const printBtn = $("ssPrint"), dlBtn = $("ssDownload"), shareBtn = $("ssShare"), newBtn = $("ssNew");
  if (printBtn) printBtn.addEventListener("click", () => openReceipt(sale));
  if (dlBtn) dlBtn.addEventListener("click", () => downloadReceipt(sale));
  if (shareBtn) shareBtn.addEventListener("click", () => shareReceipt(sale));
  if (newBtn) newBtn.addEventListener("click", () => { closeModal(); renderCatalog(); renderCart(); });
}

/* Code 39 barcode for the receipt number — pure DOM, prints on any
   thermal printer. Encodes the digits of the receipt number (e.g.
   RF-20260904-000012 -> 20260904000012) so it stays narrow enough for
   72 mm paper. Returns "" when there is nothing safely encodable. */
const CODE39 = {
  "0": "000110100", "1": "100100001", "2": "001100001", "3": "101100000", "4": "000110001",
  "5": "100110000", "6": "001110000", "7": "000100101", "8": "100100100", "9": "001100100",
  "A": "100001001", "B": "001001001", "C": "101001000", "D": "000011001", "E": "100011000",
  "F": "001011000", "G": "000001101", "H": "100001100", "I": "001001100", "J": "000011100",
  "K": "100000011", "L": "001000011", "M": "101000010", "N": "000010011", "O": "100010010",
  "P": "001010010", "Q": "000000111", "R": "100000110", "S": "001000110", "T": "000010110",
  "U": "110000001", "V": "011000001", "W": "111000000", "X": "010010001", "Y": "110010000",
  "Z": "011010000", "-": "010000101", ".": "110000100", " ": "011000100", "*": "010010100"
};
function barcodeHtml(sale) {
  const raw = String((sale && (sale.receiptNumber || sale.id)) || "");
  let text = raw.replace(/\D/g, "");
  if (text.length < 4) text = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (text.length < 4 || text.length > 16) return "";
  const NAR = 1, WID = 2.5;
  let out = '<div class="rc-barcode" aria-hidden="true">';
  ("*" + text + "*").split("").forEach((ch) => {
    const bits = CODE39[ch];
    if (!bits) return;
    for (let i = 0; i < 9; i++) {
      out += '<span class="' + (i % 2 === 0 ? "rc-bar" : "rc-gap") + '" style="width:' + (bits.charAt(i) === "1" ? WID : NAR) + 'px"></span>';
    }
    out += '<span class="rc-gap" style="width:' + NAR + 'px"></span>';
  });
  return out + '</div>';
}

function receiptHtml(sale) {
  const n2 = (v) => (Number(v) || 0).toFixed(2);
  const biz = state.business || {};
  const items = (sale.items && sale.items.length ? sale.items : []);
  const itemRows = items.map((it) => {
    const hasOffer = it.hasOffer && it.savings > 0;
    return '<div class="rc-item"><div class="rc-item-top"><span class="rc-item-name">' + esc(it.name || it.productId || "Item") + '</span>' +
      '<span class="rc-item-amt">' + n2(it.total) + '</span></div>' +
      '<div class="rc-item-sub">' + (Number(it.quantity) || 0) + (it.price != null ? " × " + n2(it.price) : "") + '</div>' +
      (hasOffer ? '<div class="rc-item-offer">Saved ' + n2(it.savings * it.quantity) + '</div>' : '') +
      '</div>';
  }).join("");
  const taxRate = state.settings && state.settings.taxRate != null ? Number(state.settings.taxRate) : 0;
  
  // Calculate total savings from offers
  const totalSavings = items.reduce((sum, it) => sum + (it.hasOffer ? it.savings * it.quantity : 0), 0);
  
  const rows =
    '<div class="rc-trow"><span>Subtotal</span><span>' + n2(sale.subtotal) + '</span></div>' +
    (totalSavings > 0 ? '<div class="rc-trow rc-offer"><span>Offer savings</span><span>-' + n2(totalSavings) + '</span></div>' : '') +
    (Number(sale.discount) > 0 ? '<div class="rc-trow rc-offer"><span>Other discounts</span><span>-' + n2(sale.discount) + '</span></div>' : "") +
    (Number(sale.tax) > 0 ? '<div class="rc-trow"><span>Tax' + (taxRate > 0 ? " (VAT " + taxRate + "%)" : "") + '</span><span>' + n2(sale.tax) + '</span></div>' : "") +
    '<div class="rc-total"><span>TOTAL</span><span>' + n2(sale.total) + '</span></div>';
  const cashier = sale.cashierName || (state.profile && state.profile.name) || "";
  const customer = sale.customerName || (sale.customerId ? "Customer" : "Walk-in");
  const meta = [
    ["Receipt #", sale.receiptNumber || sale.id, true],
    ["Date", fmtDateTime(sale.date || sale.created_at), false],
    cashier ? ["Served by", cashier, false] : null,
    ["Customer", customer, false]
  ].filter(Boolean).map((m) =>
    '<div><span class="rc-mlabel">' + m[0] + '</span><span class="rc-mval' + (m[2] ? " mono" : "") + '">' + esc(m[1] || "—") + '</span></div>'
  ).join("");
  const paid = Number(sale.amount) || 0;
  const change = Number(sale.change) || 0;
  const mpesaReceipt = String(sale.mpesaReceiptNumber || "").trim();
  const pays =
    '<div class="rc-pay"><span>Paid via</span><span>' + esc(sale.paymentMethod || "Cash") + '</span></div>' +
    (mpesaReceipt ? '<div class="rc-pay"><span>M-Pesa Receipt</span><span class="mono">' + esc(mpesaReceipt) + '</span></div>' : "") +
    (paid > 0 ? '<div class="rc-pay"><span>Amount received</span><span>' + n2(paid) + '</span></div>' : "") +
    (change > 0 ? '<div class="rc-pay"><span>Change</span><span>' + n2(change) + '</span></div>' : "");
  const line = (t) => (t ? '<div class="rc-line">' + esc(t) + '</div>' : "");
  /*
   Location lines: Address + City from the Business Profile, deduplicated.
   The admin can type the same location into both fields (or include the
   city inside the address, e.g. "Moi Avenue, Nairobi" + "Nairobi"), which
   used to print the location twice on the receipt header. A line is
   skipped when every comma-separated segment of it was already printed,
   or when it merely repeats the business name.
  */
  const locSegments = (v) => String(v || "").toLowerCase().split(/[,|·•]+/).map((s) => s.trim()).filter(Boolean);
  const bizNameKey = String(biz.name || "").trim().toLowerCase();
  const seenLocSegments = [];
  const locLines = [biz.address, biz.city]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .filter((part) => {
      const segs = locSegments(part);
      const isDup =
        (segs.length && seenLocSegments.some((existing) => segs.every((s) => existing.indexOf(s) !== -1))) ||
        (bizNameKey && segs.length && segs.every((s) => bizNameKey.indexOf(s) !== -1));
      if (isDup) return false;
      segs.forEach((s) => seenLocSegments.push(s));
      return true;
    })
    .map(line)
    .join("");
  const head =
    '<div class="rc-logo-fallback">' + esc(((biz.name || "R").trim().charAt(0) || "R").toUpperCase()) + '</div>' +
    '<div class="rc-name">' + esc(biz.name || "RetailFlow POS") + '</div>' +
    locLines + line(biz.phone) +
    ((biz.reg_no || biz.regNo) ? line("Reg: " + (biz.reg_no || biz.regNo)) : "") +
    ((biz.tax_no || biz.taxNo) ? line("PIN: " + (biz.tax_no || biz.taxNo)) : "") +
    '<div class="rc-currency">All amounts in ' + esc(currency()) + '</div>';
  const count = items.reduce((a, it) => a + (Number(it.quantity) || 0), 0);
  return '<div class="receipt">' + head +
    '<hr class="rc-sep">' +
    '<div class="rc-meta">' + meta + '</div>' +
    '<hr class="rc-sep">' +
    (itemRows || '<div class="rc-item-top"><span class="rc-item-name">No items</span><span class="rc-item-amt">0.00</span></div>') +
    '<hr class="rc-sep">' +
    rows +
    '<hr class="rc-sep">' +
    pays +
    '<hr class="rc-sep">' +
    '<div class="rc-count">' + count + (count === 1 ? " item" : " items") + '</div>' +
    barcodeHtml(sale) +
    '<div class="rc-barcode-num">' + esc(sale.receiptNumber || sale.id) + '</div>' +
    '<div class="rc-copy">*** CUSTOMER COPY ***</div>' +
    '<div class="rc-footer">' + esc((state.settings && state.settings.receiptFooter) || "Thank you for shopping with us!") + '</div>' +
    '<div class="rc-powered">Powered by Prince Alex Digital - 0717 384 875</div></div>';
}

function openReceipt(sale) {
  sale = sale || state._lastSale;
  if (!sale) return;
  openModal('<div class="receipt-shell"><div class="receipt-print-root" id="receiptPrintRoot">' + receiptHtml(sale) + '</div></div>' +
    '<div class="modal-foot"><button type="button" class="btn btn-ghost" data-modal-close>Close</button>' +
    '<button type="button" class="btn btn-primary" id="receiptPrintBtn"><i class="fa-solid fa-print" aria-hidden="true"></i> Print</button></div>', { sticky: true });
  const pb = $("receiptPrintBtn");
  if (pb) pb.addEventListener("click", () => printReceipt());
}

function printReceipt() {
  const root = $("receiptPrintRoot");
  if (!root) return;
  const win = window.open("", "_blank", "width=420,height=700");
  if (!win) { showToast("info", "Popup blocked", "Allow popups to print the receipt."); return; }
  win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt</title><style>' + PRINT_CSS + '</style></head><body>' + root.innerHTML + '</body></html>');
  win.document.close();
  setTimeout(() => { win.print(); }, 250);
}

function downloadReceipt(sale) {
  sale = sale || state._lastSale;
  if (!sale) return;
  const doc = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Receipt " + esc(sale.receiptNumber || sale.id) + "</title><style>" + PRINT_CSS + "</style></head><body>" + receiptHtml(sale) + "</body></html>";
  const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "receipt-" + (sale.receiptNumber || sale.id) + ".html";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function shareReceipt(sale) {
  sale = sale || state._lastSale;
  if (!sale) return;
  const text = "Receipt #" + (sale.receiptNumber || sale.id) + "\nTotal: " + money(sale.total) + "\nPayment: " + (sale.paymentMethod || "Cash");
  if (navigator.share) { navigator.share({ title: "RetailFlow Receipt", text: text }).catch(() => {}); }
  else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => showToast("success", "Copied", "Receipt details copied.")).catch(() => {});
  } else { showToast("info", "Share", text); }
}

const PRINT_CSS = "*{box-sizing:border-box;margin:0;padding:0;}body{width:74mm;margin:0 auto;padding:4mm 3mm;font-family:'Courier New',ui-monospace,'Lucida Console',monospace;font-size:11.5px;line-height:1.5;color:#000;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}" +
  ".rc-logo{width:20mm;height:20mm;object-fit:contain;display:block;margin:0 auto 2mm;}.rc-logo-fallback{width:13mm;height:13mm;margin:0 auto 2.5mm;display:flex;align-items:center;justify-content:center;border:2px solid #000;border-radius:50%;font-weight:bold;font-size:8mm;}" +
  ".rc-name{text-align:center;font-weight:bold;font-size:15px;letter-spacing:.4px;}.rc-line{text-align:center;font-size:10.5px;line-height:1.55;}.rc-currency{text-align:center;font-size:9.5px;margin-top:1.5mm;}" +
  ".rc-sep{border:0;height:0;border-top:1px dashed #000;margin:2.4mm 0;}" +
  ".rc-meta{font-size:11px;}.rc-meta>div{display:flex;justify-content:space-between;gap:6px;padding:.5mm 0;}.rc-mlabel{flex:none;}.rc-mval{text-align:right;word-break:break-word;min-width:0;}.mono{font-family:inherit;}" +
  ".rc-item{padding:1.2mm 0;}.rc-item+.rc-item{border-top:1px dotted #000;}.rc-item-top{display:flex;justify-content:space-between;gap:6px;font-size:11.5px;}.rc-item-name{flex:1;word-break:break-word;}.rc-item-amt{white-space:nowrap;font-weight:bold;}.rc-item-sub{font-size:10px;margin-top:.4mm;padding-left:2mm;}" +
  ".rc-trow{display:flex;justify-content:space-between;font-size:11.5px;padding:.7mm 0;}.rc-offer{font-weight:bold;}.rc-total{display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid #000;margin-top:1mm;padding-top:1.6mm;font-size:15px;font-weight:bold;}" +
  ".rc-pay{display:flex;justify-content:space-between;font-size:11px;padding:.5mm 0;}.rc-count{text-align:center;font-size:9.5px;margin-top:1.6mm;}" +
  ".rc-barcode{display:flex;align-items:stretch;justify-content:center;height:11mm;margin:2.2mm auto .8mm;}.rc-bar{background:#000;height:100%;display:inline-block;}.rc-gap{display:inline-block;height:100%;}" +
  ".rc-barcode-num{text-align:center;font-size:10.5px;letter-spacing:2px;font-weight:bold;}.rc-copy{text-align:center;font-size:9.5px;letter-spacing:3px;margin-top:2mm;}.rc-footer{text-align:center;font-size:11px;margin-top:2mm;}.rc-powered{text-align:center;font-size:8.5px;margin-top:1.2mm;}" +
  "@page{margin:0 3mm;}";

function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

/* ==================================================================
   VIEWS — Sales / Products / Customers + sidebar nav
   ================================================================== */

const NAV_ITEMS = [
  { view: "pos", icon: "fa-cash-register", label: "POS" },
  { view: "sales", icon: "fa-receipt", label: "Sales", roles: ["owner", "admin", "store_manager", "cashier", "sales_staff", "waiter", "accountant"] },
  { view: "products", icon: "fa-box", label: "Products", roles: ["owner", "admin", "store_manager", "inventory_manager"] },
  { view: "customers", icon: "fa-user-group", label: "Customers", roles: ["owner", "admin", "store_manager", "cashier", "sales_staff"] }
];

function buildSidebar() {
  const nav = $("sideNav");
  if (!nav) return;
  const role = state.profile.role;
  const activeModules = state.modules || [];
  nav.innerHTML = NAV_ITEMS.filter((item) =>
      (!item.roles || item.roles.includes(role)) &&
      (item.view === "pos" || activeModules.indexOf(item.view) !== -1))
    .map((item) => {
      const itemLabel = item.view === "products"
        ? ((state.labels && state.labels.product) || item.label)
        : item.label;
      return '<button type="button" class="nav-item' + (item.view === "pos" ? " active" : "") + '" data-view="' + item.view + '">' +
        '<i class="fa-solid ' + item.icon + '" aria-hidden="true"></i><span>' + itemLabel + '</span></button>';
    }).join("");
  nav.querySelectorAll(".nav-item").forEach((n) => n.addEventListener("click", () => switchView(n.dataset.view)));
}

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => { v.hidden = true; });
  const target = $("view-" + view);
  if (target) target.hidden = false;
  if (target && view === "products") {
    const h = target.querySelector("h2");
    if (h) h.textContent = (state.labels && state.labels.product) || "Products";
  }
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
  state.currentView = view;
  if (view === "pos") { renderCatalog(); renderCart(); }
  else if (view === "sales") { if (!state.salesLoaded) loadSales(); else renderSales(); }
  else if (view === "products") renderProductsList();
  else if (view === "customers") renderCustomers();
}

/* ---------------- Refund requests ----------------
   Cashiers request a refund on a past sale; the request is
   submitted to an admin / store manager for approval. Once
   approved (in the POS by a manager, or in the admin console)
   the Worker flips the sale to "Refunded" and restores stock. */

function refundForSale(saleId) {
  return (state.refunds || []).find((r) => r.saleId === saleId) || null;
}

function saleStatusBadge(s) {
  if (s.status === "Refunded") return '<span class="badge badge-danger">Refunded</span>';
  const rr = refundForSale(s.id);
  if (rr && rr.status === "Pending") return '<span class="badge badge-warning">Refund pending</span>';
  if (rr && rr.status === "Approved") return '<span class="badge badge-danger">Refunded</span>';
  if (rr && rr.status === "Rejected") return '<span class="badge badge-neutral">Refund declined</span>';
  return '<span class="badge ' + (s.status === "Completed" ? "badge-success" : "badge-warning") + '">' + esc(s.status || "Completed") + '</span>';
}

function saleActions(s) {
  let html = '<button type="button" class="ghost-btn btn-sm" data-reprint="' + esc(s.id) + '">Receipt</button>';
  const rr = refundForSale(s.id);
  const pending = !!(rr && rr.status === "Pending");
  if (s.status !== "Refunded" && !pending) {
    html += ' <button type="button" class="ghost-btn btn-sm" data-refund="' + esc(s.id) + '">Refund</button>';
  }
  if (pending && can(["owner", "admin", "store_manager"])) {
    html += ' <button type="button" class="ghost-btn btn-sm" data-refund-decide="Approved" data-refund-id="' + esc(rr.id) + '">Approve</button>' +
      ' <button type="button" class="ghost-btn btn-sm" data-refund-decide="Rejected" data-refund-id="' + esc(rr.id) + '">Reject</button>';
  }
  return html;
}

function loadRefunds() {
  api.refunds()
    .then((data) => { state.refunds = data.requests || []; renderSales(); })
    .catch(() => { state.refunds = []; });
}

function openRefundRequest(sale) {
  const itemCount = Array.isArray(sale.items) ? sale.items.length : 0;
  const maxAmount = round2(sale.total);
  const body =
    '<div class="refund-summary">' +
    '<div><span>Receipt</span><strong class="mono">' + esc(sale.receiptNumber || sale.id) + '</strong></div>' +
    '<div><span>Date</span><strong>' + esc(fmtDateTime(sale.date)) + '</strong></div>' +
    '<div><span>Items</span><strong>' + itemCount + '</strong></div>' +
    '<div><span>Total</span><strong>' + money(sale.total) + '</strong></div>' +
    '</div>' +
    '<div class="field"><label for="refundReason">Reason for refund *</label>' +
    '<textarea id="refundReason" rows="3" maxlength="500" placeholder="e.g. Damaged item, wrong product, customer changed their mind…"></textarea></div>' +
    '<div class="field"><label for="refundAmount">Amount to refund</label>' +
    '<input type="number" id="refundAmount" min="0.01" max="' + maxAmount + '" step="0.01" value="' + maxAmount + '">' +
    '<small class="field-hint">Maximum ' + money(sale.total) + '. The request is sent to an admin or store manager for approval — stock and customer totals are only restored once it is approved.</small></div>';
  const footer =
    '<button type="button" class="btn btn-ghost" data-modal-close>Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="refundSubmitBtn"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Submit request</button>';
  openModal(
    modalShell("Request refund", "This request will be submitted to an admin or store manager for approval.", body, footer),
    { sticky: true }
  );
  if ($("refundSubmitBtn")) $("refundSubmitBtn").addEventListener("click", () => submitRefundRequest(sale));
}

async function submitRefundRequest(sale) {
  const reasonEl = $("refundReason");
  const amountEl = $("refundAmount");
  const reason = ((reasonEl && reasonEl.value) || "").trim();

  if (!reason) {
    showToast("error", "Reason required", "Please tell the manager why this sale is being refunded.");
    if (reasonEl) reasonEl.focus();
    return;
  }

  let amount = round2(parseFloat(amountEl && amountEl.value));
  if (!Number.isFinite(amount) || amount <= 0) amount = round2(sale.total);
  if (amount > round2(sale.total)) amount = round2(sale.total);

  const btn = $("refundSubmitBtn");
  if (btn) btn.disabled = true;

  try {
    await api.createRefund({ saleId: sale.id, reason: reason, amount: amount });
    closeModal();
    showToast("success", "Refund requested", "Submitted to an admin or store manager for approval.");
    loadSales();
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast("error", "Could not submit refund", err.message);
  }
}

function decideOnRefund(rr, decision) {
  const approved = decision === "Approved";
  showConfirmDialog({
    title: approved ? "Approve refund" : "Reject refund",
    message: approved
      ? "Approve the refund of " + money(rr.amount) + " for receipt " + (rr.receiptNumber || rr.saleId) + "? The sale will be marked as refunded and stock restored."
      : "Reject the refund request for receipt " + (rr.receiptNumber || rr.saleId) + "?",
    confirmText: approved ? "Approve" : "Reject",
    cancelText: "Cancel",
    onConfirm: async () => {
      try {
        await api.decideRefund(rr.id, { decision: decision });
        showToast(
          "success",
          approved ? "Refund approved" : "Refund rejected",
          approved ? "The sale is now marked as refunded." : "The cashier can submit a new request if needed."
        );
        loadSales();
      } catch (err) {
        showToast("error", approved ? "Could not approve refund" : "Could not reject refund", err.message);
      }
    }
  });
}

function renderSales() {
  const wrap = $("salesTableWrap");
  const count = $("salesCount");
  if (!wrap) return;
  if (!state.sales) { wrap.innerHTML = '<div class="empty-state"><div class="boot-spinner"></div><p>Loading sales…</p></div>'; return; }
  if (count) count.textContent = state.sales.length + " sale" + (state.sales.length === 1 ? "" : "s");
  if (!state.sales.length) { wrap.innerHTML = '<div class="empty-state"><i class="fa-solid fa-receipt" aria-hidden="true"></i><p>No sales yet.</p></div>'; return; }
  const onlyMine = $("mySalesOnly") && $("mySalesOnly").checked;
  const rows = state.sales.filter((s) => !onlyMine || s.cashierId === state.profile.id);
  if (count) count.textContent = rows.length + " sale" + (rows.length === 1 ? "" : "s");
  wrap.innerHTML = '<div class="table-wrap"><table class="rf-table"><thead><tr><th>Receipt #</th><th>Date</th><th>Customer</th><th>Payment</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead><tbody>' +
    rows.map((s) => '<tr><td><span class="mono">' + esc(s.receiptNumber || s.id) + '</span></td><td>' + fmtDateTime(s.date || s.created_at) + '</td>' +
      '<td>' + esc(s.customerName || (s.customerId ? "Customer" : "Walk-in")) + '</td><td>' + esc(s.paymentMethod || "Cash") + '</td><td class="num">' + money(s.total) + '</td>' +
      '<td>' + saleStatusBadge(s) + '</td>' +
      '<td>' + saleActions(s) + '</td></tr>').join("") + '</tbody></table></div>';
}

function loadSales() {
  state.sales = null;
  renderSales();
  if (isOffline) {
    /* Offline — serve from IndexedDB cache if available. */
    localDB.get("sales").then((cached) => {
      state.sales = (cached || []).map(normSale);
      state.salesLoaded = true;
      renderSales();
    }).catch(() => { state.sales = []; renderSales(); });
    return;
  }
  api.sales().then((data) => {
    state.sales = (data.sales || []).map(normSale);
    state.salesLoaded = true;
    renderSales();
    /* Refresh the cached copy for next offline session */
    if (state.sales && state.sales.length) { try { localDB.set("sales", state.sales); } catch (e) {} }
  })
    .catch((err) => {
      if (err && (err.kind === "network" || err.kind === "timeout" || err.status === 0)) {
        /* Network dropped mid-action — fall back to cache. */
        localDB.get("sales").then((cached) => {
          state.sales = (cached || []).map(normSale);
          state.salesLoaded = true;
          renderSales();
        }).catch(() => { state.sales = []; renderSales(); });
        return;
      }
      state.sales = [];
      renderSales();
      showToast("error", "Could not load sales", err.message);
    });
  loadRefunds();
}

function renderProductsList() {
  const wrap = $("productsTableWrap");
  const count = $("productsCount");
  if (!wrap) return;
  if (count) count.textContent = state.products.length + " product" + (state.products.length === 1 ? "" : "s");
  if (!state.products.length) { wrap.innerHTML = '<div class="empty-state"><i class="fa-solid fa-box-open" aria-hidden="true"></i><p>No products available.</p><small>Add products from the Inventory module.</small></div>'; return; }
  wrap.innerHTML = '<div class="table-wrap"><table class="rf-table"><thead><tr><th>Product</th><th>SKU</th><th>Category</th><th class="num">Price</th><th class="num">Stock</th><th>Status</th></tr></thead><tbody>' +
    state.products.map((p) => '<tr><td><strong>' + esc(p.name) + '</strong></td><td class="mono">' + esc(p.sku || "—") + '</td><td>' + esc(p.category) + '</td>' +
      '<td class="num">' + money(p.price) + '</td><td class="num">' + p.stock + '</td><td>' + stockBadge(p) + '</td></tr>').join("") + '</tbody></table></div>';
}

function renderCustomers() {
  const wrap = $("customersTableWrap");
  if (!wrap) return;
  if (!state.customers.length) { wrap.innerHTML = '<div class="empty-state"><i class="fa-solid fa-user-group" aria-hidden="true"></i><p>No customers found.</p></div>'; return; }
  wrap.innerHTML = '<div class="table-wrap"><table class="rf-table"><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Total purchases</th><th class="num"></th></tr></thead><tbody>' +
    state.customers.map((c) => '<tr><td><strong>' + esc(c.name) + '</strong></td><td>' + esc(c.phone || "—") + '</td><td>' + esc(c.email || "—") + '</td><td>' + esc(c.totalPurchases || 0) + '</td>' +
      '<td><button type="button" class="ghost-btn btn-sm" data-pick-customer="' + esc(c.id) + '">Select</button></td></tr>').join("") + '</tbody></table></div>';
}

function openCustomerSelector() {
  const body = '<div class="cs-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>' +
    '<input type="text" id="csInput" placeholder="Search customer by name or phone…" autocomplete="off"></div>' +
    '<div class="cs-list" id="csList"></div><div class="cs-create" id="csCreate"></div>';
  openModal(modalShell("Select Customer", "Attach a customer to this sale, or continue as Walk-in Customer.", body), { sticky: true });
  state._cs = { q: "" };
  renderCsList();
  const inp = $("csInput");
  if (inp) inp.addEventListener("input", debounce(() => { state._cs.q = inp.value.trim().toLowerCase(); renderCsList(); }, 180));
}

function renderCsList() {
  const list = $("csList");
  if (!list) return;
  const q = (state._cs && state._cs.q) || "";
  const matches = state.customers.filter((c) => !q || (c.name || "").toLowerCase().includes(q) || (c.phone || "").toLowerCase().includes(q));
  if (!matches.length) {
    list.innerHTML = '<div class="cs-empty">No matching customers. <button type="button" class="link-btn" id="csAddNew">+ Create new customer</button></div>';
    const add = $("csAddNew");
    if (add) add.addEventListener("click", () => showCustomerCreate());
    return;
  }
  list.innerHTML = matches.map((c) =>
    '<button type="button" class="cs-item" data-customer="' + esc(c.id) + '"><span class="cs-name">' + esc(c.name) + '</span>' +
    '<span class="cs-sub">' + esc(c.phone || "—") + (c.email ? " · " + esc(c.email) : "") + '</span></button>'
  ).join("");
  list.querySelectorAll("[data-customer]").forEach((b) => b.addEventListener("click", () => {
    const c = state.customers.find((x) => x.id === b.dataset.customer);
    if (c) { state.customer = c; if ($("customerName")) $("customerName").textContent = c.name; }
    closeModal();
  }));
}

function showCustomerCreate() {
  const box = $("csCreate");
  const list = $("csList");
  if (list) list.hidden = true;
  if (!box) return;
  box.hidden = false;
  box.innerHTML =
    '<div class="cs-form-title">New customer</div>' +
    '<div class="cs-field"><label for="cnName">Full Name *</label><input type="text" id="cnName" required></div>' +
    '<div class="cs-field"><label for="cnPhone">Phone</label><input type="tel" id="cnPhone"></div>' +
    '<div class="cs-field"><label for="cnEmail">Email</label><input type="email" id="cnEmail"></div>' +
    '<div class="cs-form-actions"><button type="button" class="btn btn-ghost" id="cnCancel">Cancel</button>' +
    '<button type="button" class="btn btn-primary" id="cnSave">Save & Select</button></div>';
  const cancel = $("cnCancel");
  if (cancel) cancel.addEventListener("click", () => { box.hidden = true; if (list) list.hidden = false; });
  const save = $("cnSave");
  if (save) save.addEventListener("click", async () => {
    const name = ($("cnName").value || "").trim();
    const phone = ($("cnPhone").value || "").trim();
    const email = ($("cnEmail").value || "").trim();
    if (!name) { showToast("error", "Name required", "Enter the customer’s name."); return; }
    save.disabled = true; save.classList.add("is-loading");
    try {
      const resp = await api.createCustomer({ name: name, phone: phone, email: email });
      const created = resp.customer || { id: "cust_" + Date.now(), name: name, phone: phone, email: email, totalPurchases: 0 };
      state.customers.unshift(created);
      state.customer = created;
      if ($("customerName")) $("customerName").textContent = created.name;
      closeModal();
      showToast("success", "Customer added", created.name + " saved.");
    } catch (err) {
      showToast("error", "Could not save", err.message);
      save.disabled = false; save.classList.remove("is-loading");
    }
  });
}

function renderAll() {
  renderCatalog(); renderCategories(); renderCart(); buildSidebar();
  setText("bizChipText", (state.business && state.business.name) || "—");
  setText("userName", state.profile.name);
  setText("userRole", ROLE_DISPLAY[state.profile.role] || state.profile.role);
  const av = $("userAvatar"); if (av) av.textContent = initials(state.profile.name);
  const branchName = state.branchId ? ((state.branches.find((b) => b.id === state.branchId) || {}).name || state.branchId) : "—";
  const bs = $("branchSelect"), bst = $("branchStatic");
  if (state.profile.role === "owner" && state.branches.length > 1) {
    if (bs) { bs.hidden = false; if (bst) bst.hidden = true; bs.innerHTML = state.branches.map((b) => '<option value="' + esc(b.id) + '"' + (b.id === state.branchId ? " selected" : "") + ">" + esc(b.name) + "</option>").join(""); }
  } else { if (bs) bs.hidden = true; if (bst) { bst.hidden = false; bst.textContent = branchName; } }
  const showAdmin = can(ADMIN_CONSOLE_ROLES) && state.business;
  if ($("adminLink")) $("adminLink").hidden = !showAdmin;
  if ($("adminConsoleLink")) $("adminConsoleLink").hidden = !showAdmin;
  if ($("discountRow")) $("discountRow").hidden = !(state.settings && state.settings.enableDiscounts && can(DISCOUNT_ROLES));
  if ($("mySalesWrap")) $("mySalesWrap").hidden = !SELF_SALES_ROLES.includes(state.profile.role);
}

function wireEvents() {
  const grid = $("productGrid");
  if (grid) grid.addEventListener("click", (e) => { const card = e.target.closest("[data-product]"); if (card && !card.disabled) { const p = state.products.find((x) => x.id === card.dataset.product); if (p) addToCart(p); } });
  const ci = $("cartItems");
  if (ci) ci.addEventListener("click", (e) => { const btn = e.target.closest("button"); if (!btn) return; const el = e.target.closest(".cart-item"); if (!el) return; const pid = el.dataset.product; if (btn.classList.contains("ci-remove")) removeFromCart(pid); else if (btn.classList.contains("qty-btn")) updateCartQty(pid, parseInt(btn.dataset.delta, 10)); });
  if (ci) ci.addEventListener("change", (e) => { if (e.target.classList.contains("qty-input")) { const el = e.target.closest(".cart-item"); if (el) setCartQty(el.dataset.product, e.target.value); } });
  if ($("clearCartBtn")) $("clearCartBtn").addEventListener("click", clearCart);
  if ($("payBtn")) $("payBtn").addEventListener("click", openCheckout);
  if ($("customerBtn")) $("customerBtn").addEventListener("click", openCustomerSelector);
  const catBar = $("categoryBar");
  if (catBar) catBar.addEventListener("click", (e) => { const c = e.target.closest("[data-cat]"); if (c) { state.activeCategory = c.dataset.cat; renderCatalog(); renderCategories(); } });
  const search = $("productSearch");
  if (search) search.addEventListener("input", debounce(() => { state.search = search.value; renderCatalog(); if ($("searchClear")) $("searchClear").hidden = !search.value; }, 150));
  if ($("searchClear")) $("searchClear").addEventListener("click", () => { state.search = ""; if (search) search.value = ""; if ($("globalSearch")) $("globalSearch").value = ""; renderCatalog(); $("searchClear").hidden = true; if (search) search.focus(); });
  const gs = $("globalSearch");
  if (gs) gs.addEventListener("input", debounce(() => { state.search = gs.value; if (search && document.activeElement !== search) search.value = gs.value; if (state.currentView !== "pos") switchView("pos"); renderCatalog(); if ($("searchClear")) $("searchClear").hidden = !gs.value; }, 180));
  function handleBarcode(src) { const val = (src.value || "").trim(); if (!val) return false; const found = findProduct(val); if (found) { addToCart(found); src.value = ""; state.search = ""; if ($("searchClear")) $("searchClear").hidden = true; renderCatalog(); return true; } showToast("error", "Product not found", "No product matches “" + esc(val) + "”."); return false; }
  if (search) search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handleBarcode(search); } });
  if (gs) gs.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); handleBarcode(gs); } });
  if ($("discountInput")) $("discountInput").addEventListener("input", debounce(renderCart, 80));
  if ($("discountInput")) $("discountInput").addEventListener("change", renderCart);
  const dt = $("discountTypeBtn");
  if (dt) { dt.dataset.pct = "1"; dt.addEventListener("click", () => { const p = dt.dataset.pct === "1"; dt.dataset.pct = p ? "0" : "1"; dt.textContent = p ? "KES" : "%"; renderCart(); }); }
  if ($("branchSelect")) $("branchSelect").addEventListener("change", (e) => { state.branchId = e.target.value; renderAll(); refreshCatalog(); });
  if ($("menuBtn")) $("menuBtn").addEventListener("click", () => document.body.classList.add("nav-open"));
  if ($("sidebarBackdrop")) $("sidebarBackdrop").addEventListener("click", () => document.body.classList.remove("nav-open"));
  if ($("sideClose")) $("sideClose").addEventListener("click", () => document.body.classList.remove("nav-open"));
  if ($("cartFab")) $("cartFab").addEventListener("click", () => document.body.classList.add("cart-open"));
  if ($("logoutBtn")) $("logoutBtn").addEventListener("click", () => {
    showConfirmDialog({
      title: "Sign out",
      message: "Are you sure you want to sign out of RetailFlow POS?",
      confirmText: "Sign out",
      cancelText: "Cancel",
      onConfirm: () => doSignOut()
    });
  });
  const sw = $("salesTableWrap");
  if (sw) sw.addEventListener("click", (e) => {
    const reprint = e.target.closest("[data-reprint]");
    if (reprint) { const s = (state.sales || []).find((x) => x.id === reprint.dataset.reprint); if (s) openReceipt(s); return; }
    const refundBtn = e.target.closest("[data-refund]");
    if (refundBtn) { const s = (state.sales || []).find((x) => x.id === refundBtn.dataset.refund); if (s) openRefundRequest(s); return; }
    const decideBtn = e.target.closest("[data-refund-decide]");
    if (decideBtn) { const rr = (state.refunds || []).find((x) => x.id === decideBtn.dataset.refundId); if (rr) decideOnRefund(rr, decideBtn.dataset.refundDecide); return; }
  });
  if ($("salesRefresh")) $("salesRefresh").addEventListener("click", loadSales);
  if ($("mySalesOnly")) $("mySalesOnly").addEventListener("change", renderSales);
  const cw = $("customersTableWrap");
  if (cw) cw.addEventListener("click", (e) => { const b = e.target.closest("[data-pick-customer]"); if (b) { const c = state.customers.find((x) => x.id === b.dataset.pickCustomer); if (c) { switchView("pos"); state.customer = c; if ($("customerName")) $("customerName").textContent = c.name; renderCart(); } } });

  /* ---- Barcode scanner auto-detect ---- */
  barcodeScanner.attach((barcode) => {
    const found = findProduct(barcode);
    if (found) {
      addToCart(found);
      // Clear search fields to reset view
      state.search = "";
      if (search) search.value = "";
      if (gs) gs.value = "";
      if ($("searchClear")) $("searchClear").hidden = true;
      renderCatalog();
      showToast("success", "Added: " + found.name, "Scanned via barcode");
    } else {
      showToast("error", "Product not found", "No product matches barcode: " + esc(barcode));
    }
  });
}

/* ==================================================================
   BOOT
   ================================================================== */

async function startup() {
  const profile = state.profile;
  // Role gating
  if (!POS_ACCESS_ROLES.includes(profile.role)) {
    showDenied(POS_ACCESS_ROLES.includes(profile.role) ? null :
      "This account does not have permission to use the POS terminal.");
    return;
  }
  renderAll();
  wireEvents();
  startClock();
  try {
    await loadWorkspace();
  } catch (err) {
    if (err.message === "no-business") return;
    console.warn("[RetailFlow POS] workspace error:", err);
  }
  /* Self-transaction roles (cashier, sales_staff, waiter) start on
     "My sales only" — their whole history lives in the Admin Console. */
  if ($("mySalesOnly")) $("mySalesOnly").checked = SELF_SALES_ROLES.includes(profile.role);
  // Refresh sales count badge if needed
  if (profile.role !== "cashier") {
    loadSales();
  }
}

let booting = false;
async function boot() {
  if (booting) return;
  booting = true;
  /* Offline capability — set up connectivity listeners + badge, and
     register the service worker for the app-shell cache. Done before
     auth so the terminal can boot into offline mode. */
  initOffline();
  registerServiceWorker();
  /* If we recover online and have queued writes, drain them on start. */
  if (navigator.onLine) syncPendingQueue();
  onAuthStateChanged(auth, async (user) => {
    if (!user) { redirectToLogin(); return; }
    state.user = user;
    state.authed = true;
    try {
      const raw = await loadProfile(user);
      state.profile = {
        id: raw.id, name: raw.name || raw.email || "User", email: raw.email || "",
        role: raw.role || "cashier", businessId: raw.businessId || null,
        branchId: raw.branchId || null, needsOnboarding: !!raw.needsOnboarding
      };
      try { await loadBusinessContext(); } catch (err) { return; }
      await startup();
    } catch (err) {
      console.warn("[RetailFlow POS] auth error:", err);
      if (err.status === 401 || err.status === 403) { redirectToLogin(); return; }
      showDenied("We could not load your account. Please try again or contact your administrator.");
    }
  });
}

boot();

function startClock() { const tick = () => { const el = $("clock"); if (el) { try { el.textContent = new Date().toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }); } catch (e) { el.textContent = new Date().toLocaleTimeString(); } } }; tick(); setInterval(tick, 30000); }