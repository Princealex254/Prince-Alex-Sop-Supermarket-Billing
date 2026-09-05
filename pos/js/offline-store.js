/* ==================================================================
   RetailFlow — offline-store.js
   ------------------------------------------------------------------
   A promise-based IndexedDB wrapper that gives the POS terminal a
   local persistence layer so it can run during network outages.

   Two object stores:
     • "cache"  — key/value cache of API responses:
                  profile, business, branches, settings, mpesa,
                  products, customers, sales
     • "pending" — queue of write operations (sales, customer
                   creates, refunds) that failed or were created
                   while offline and must be synced to the Worker.

   This module is dependency-free (native IndexedDB only) so it can
   run in the same ES-module stack as pos.js with no build step.

   Usage:
     import { localDB } from "./offline-store.js";
     await localDB.ready;
     await localDB.set("products", data);
     const data = await localDB.get("products");
   ================================================================== */

const DB_NAME = "retailflow-pos-offline";
const DB_VERSION = 1;
const CACHE_STORE = "cache";
const PENDING_STORE = "pending";

/** Promisified IndexedDB open + upgrade. Resolves with the instance. */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

let dbPromise = typeof indexedDB !== "undefined" ? openDB() : Promise.reject(new Error("IndexedDB unavailable"));

export const localDB = {
  /** Resolves when the database is ready; rejects if IndexedDB is unavailable. */
  get ready() { return dbPromise; },
  get _db() { return dbPromise; },

  /* ---- Cache (read) ---- */
  async get(key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readonly");
      const st = tx.objectStore(CACHE_STORE).get(key);
      st.onsuccess = () => resolve(st.result ? st.result.value : null);
      st.onerror = (e) => reject(e.target.error);
    });
  },

  /** Set or replace a cached value. `value` may be any JSON-serialisable data. */
  async set(key, value) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      const st = tx.objectStore(CACHE_STORE).put({ key, value, updatedAt: Date.now() });
      st.onsuccess = () => resolve();
      st.onerror = (e) => reject(e.target.error);
    });
  },

  /** Merge an object into an existing cached object (or create). */
  async merge(key, patch) {
    const existing = (await this.get(key)) || {};
    const merged = Object.assign(Array.isArray(existing) ? existing : (typeof existing === "object" && existing !== null ? existing : {}), patch);
    await this.set(key, merged);
  },

  async remove(key) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).delete(key).onsuccess = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  },

  async clear() {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, "readwrite");
      tx.objectStore(CACHE_STORE).clear().onsuccess = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  },

  /* ---- Pending write queue ---- */
  /** Add a write operation to the offline queue. Returns the queue id. */
  async enqueue(op) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, "readwrite");
      const st = tx.objectStore(PENDING_STORE).add(Object.assign({ createdAt: Date.now(), attempts: 0, status: "pending" }, op));
      st.onsuccess = () => resolve(st.result);
      st.onerror = (e) => reject(e.target.error);
    });
  },

  /** All pending ops with status "pending" (sorted by createdAt). */
  async pendingOps() {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, "readonly");
      const st = tx.objectStore(PENDING_STORE).getAll();
      st.onsuccess = () => {
        const all = (st.result || []).filter((o) => o.status === "pending").sort((a, b) => a.createdAt - b.createdAt);
        resolve(all);
      };
      st.onerror = (e) => reject(e.target.error);
    });
  },

  async updateOp(id, patch) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, "readwrite");
      const store = tx.objectStore(PENDING_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) { resolve(null); return; }
        const updated = Object.assign({}, existing, patch);
        store.put(updated).onsuccess = () => resolve(updated);
      };
      getReq.onerror = (e) => reject(e.target.error);
    });
  },

  async removeOp(id) {
    const db = await dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PENDING_STORE, "readwrite");
      tx.objectStore(PENDING_STORE).delete(id).onsuccess = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }
};
