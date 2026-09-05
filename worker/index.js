/**
 * ================================================================
 * RetailFlow POS — Cloudflare Worker API
 * Powered by Prince Alex Digital
 *
 * Backend:
 *   Cloudflare Workers
 *   Cloudflare D1
 *   Cloudflare R2 (optional)
 *
 * Authentication:
 *   Firebase Authentication
 *
 * Firebase:
 *   Project ID: retailflow-pos-11726
 *
 * API:
 *   https://retailflow-api.princealexdigital.workers.dev
 * ================================================================
 */

/* ================================================================
   M-PESA CRYPTOGRAPHY (AES-256-GCM)
   ----------------------------------------------------------------
   Encrypts M-Pesa Daraja secrets (Consumer Key, Consumer Secret,
   Passkey) before they are stored in D1.

   The master key lives ONLY in the Cloudflare Worker secret
   `RETAILFLOW_ENCRYPTION_KEY`. It is never stored in D1 and never
   exposed to frontend JavaScript.

   Format of an encrypted value stored in D1:
     v1.<base64url(iv)>.<base64url(ciphertext + auth_tag)>

   - v1        version prefix (allows safe key rotation later)
   - iv        12-byte random nonce
   - ciphertext WebCrypto AES-GCM output includes the 16-byte
                authentication tag at the end

   Decryption fails loudly (auth tag mismatch) if the value was
   tampered with or the wrong key is used.
   ================================================================ */

const mpesaEncoder = new TextEncoder();
const mpesaDecoder = new TextDecoder();

/** Base64url-encode a Uint8Array (no padding). */
function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Base64url-decode into a Uint8Array (padding optional). */
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derive the AES-256-GCM key from the master secret via SHA-256.
 * The secret may be any length; hashing normalises it to 32 bytes.
 */
async function getEncryptionKey(env) {
  const secret =
    (env && env.RETAILFLOW_ENCRYPTION_KEY) || "";
  if (!secret) {
    throw new Error(
      "RETAILFLOW_ENCRYPTION_KEY is not set. Add it as a Worker secret before configuring M-Pesa."
    );
  }
  if (secret.length < 32) {
    throw new Error(
      "RETAILFLOW_ENCRYPTION_KEY is too short — it must be at least 32 characters."
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    mpesaEncoder.encode(secret)
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt a value for storage in D1. Returns the v1 envelope string. */
async function encryptSecret(value, env) {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    mpesaEncoder.encode(String(value == null ? "" : value))
  );
  return (
    "v1." +
    b64urlEncode(iv) +
    "." +
    b64urlEncode(new Uint8Array(ciphertext))
  );
}

/**
 * Decrypt a value previously produced by encryptSecret().
 * Throws on any invalid/tampered payload. Never logs secrets.
 */
async function decryptSecret(payload, env) {
  if (!payload || typeof payload !== "string") {
    throw new Error("Invalid encrypted value");
  }
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted value format");
  }
  const iv = b64urlDecode(parts[1]);
  const data = b64urlDecode(parts[2]);
  const key = await getEncryptionKey(env);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    return mpesaDecoder.decode(plaintext);
  } catch (error) {
    throw new Error(
      "Unable to decrypt stored credentials — check RETAILFLOW_ENCRYPTION_KEY"
    );
  }
}

/* ================================================================
   SAFARICOM DARAJA (M-Pesa) HTTP LAYER
   ----------------------------------------------------------------
   ALL Safaricom Daraja communication lives below so it can be
   updated to match the current official API without touching the
   POS frontend or the rest of the Worker.

   Sources of truth (current official Daraja v1 API):
     https://developer.safaricom.co.ke

   OAuth:
     GET  {base}/oauth/v1/generate?grant_type=client_credentials
     Authorization: Basic base64(consumerKey:consumerSecret)

   STK Push (Lipa na M-Pesa Online):
     POST {base}/mpesa/stkpush/v1/processrequest
     Password = base64(shortcode + passkey + Timestamp)
     Timestamp = YYYYMMDDHHmmss in Kenya time (UTC+3)
     TransactionType:
       CustomerBuyGoodsOnline  → Till Number
       CustomerPayBillOnline   → PayBill
     PartyB  = shortcode
     PartyA  = customer phone (2547XXXXXXXX / 2541XXXXXXXX)

   STK Push Query (reconciliation):
     POST {base}/mpesa/stkpushquery/v1/query

   Callback (Safaricom → RetailFlow):
     Body.stkCallback {
       MerchantRequestID, CheckoutRequestID,
       ResultCode, ResultDesc,
       CallbackMetadata.Item[]  → { Name, Value }
     }
     ResultCode 0 = success; 1032 = cancelled by customer.

   SECURITY: this layer never logs or returns tokens, secrets,
   passwords or raw authorization headers. Phone numbers are masked
   through maskPhone() for logs/audit.
   ================================================================ */

const DARAJA_BASE = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke"
};

const KENYA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, no DST

/** Friendly error whose message is always safe to show users. */
class DarajaError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "DarajaError";
    this.status = status;
  }
}

/** Resolve the Daraja base URL for a saved environment. */
function darajaBase(environment) {
  return DARAJA_BASE[environment] || DARAJA_BASE.sandbox;
}

/** Two-digit zero-pad. */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Daraja timestamp = YYYYMMDDHHmmss in Kenya time (UTC+3).
 * Daraja rejects non-Kenya times, so always convert.
 */
function formatKenyanTimestamp(date = new Date()) {
  const k = new Date(date.getTime() + KENYA_UTC_OFFSET_MS);
  return (
    String(k.getUTCFullYear()) +
    pad2(k.getUTCMonth() + 1) +
    pad2(k.getUTCDate()) +
    pad2(k.getUTCHours()) +
    pad2(k.getUTCMinutes()) +
    pad2(k.getUTCSeconds())
  );
}

/**
 * STK password = base64(shortcode + passkey + timestamp).
 */
function generateStkPassword(shortcode, passkey, timestamp) {
  return btoa(String(shortcode) + String(passkey) + String(timestamp));
}

/**
 * Normalise Kenyan mobile numbers to Daraja format (2547XXXXXXXX /
 * 2541XXXXXXXX).
 *
 * Accepts:  07XXXXXXXX  01XXXXXXXX  2547XXXXXXXX  2541XXXXXXXX
 *           +2547XXXXXXXX  +2541XXXXXXXX  (with spaces/hyphens)
 * Also tolerates the legacy 7XXXXXXXX / 1XXXXXXXX format.
 *
 * Returns the normalised number, or "" if the input is not a valid
 * Kenyan mobile number. Never mutates numbers of other countries.
 */
function normalizeKenyanPhone(input) {
  if (input == null) return "";
  let digits = String(input)
    .replace(/[\s\-().]/g, "")
    .replace(/^\+/, "");

  // Reject letters / clearly invalid characters.
  if (!/^\d{9,12}$/.test(digits)) return "";

  if (digits.length === 12 && digits.startsWith("254")) {
    // +2547XXXXXXXX / 2547XXXXXXXX
    digits = digits.substring(3);
  } else if (digits.length === 9) {
    // 7XXXXXXXX / 1XXXXXXXX (legacy format without leading 0)
    digits = "0" + digits;
  } else if (digits.length !== 10 || !digits.startsWith("0")) {
    return "";
  }

  // Must be 07/01 (Safaricom mobile prefixes).
  if (!/^0[71]/.test(digits)) return "";

  return "254" + digits.substring(1);
}

/**
 * Mask a phone number for logs / audit output, e.g.
 * 254712345678 → 2547•••••678 (last 3 digits visible).
 */
function maskPhone(input) {
  const s = String(input == null ? "" : input);
  if (s.length < 6) return "••••";
  return s.slice(0, -3).replace(/[0-9]/g, "•") + s.slice(-3);
}

/** Build the Basic Authorization header value for Daraja OAuth. */
function basicAuth(consumerKey, consumerSecret) {
  return "Basic " + btoa(String(consumerKey) + ":" + String(consumerSecret));
}

/**
 * Request a Daraja OAuth access token using the business's own
 * Consumer Key + Consumer Secret. The token is used immediately for
 * one STK call and never cached in D1, logged, or returned.
 */
async function getOAuthToken(env, cfg) {
  const base = darajaBase(cfg.environment);
  const url =
    base + "/oauth/v1/generate?grant_type=client_credentials";

  const auth = basicAuth(cfg.consumerKey, cfg.consumerSecret);

  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: auth,
        Accept: "application/json"
      }
    });
  } catch (error) {
    throw new DarajaError(
      "Unable to reach M-Pesa. Please check your connection and try again.",
      502
    );
  }

  let data = {};
  try {
    data = await res.json();
  } catch (error) {
    throw new DarajaError(
      "M-Pesa returned an unexpected response.",
      502
    );
  }

  if (!res.ok || !data.access_token) {
    throw new DarajaError(
      "Unable to authenticate with M-Pesa. Check your Consumer Key and Consumer Secret.",
      502
    );
  }

  return data.access_token;
}
/**
 * Send an STK Push prompt to the customer's phone.
 *
 * cfg — decrypted configuration: { shortcode, shortcodeType,
 *        passkey, environment, accountReference, transactionDesc }
 * pay — { amount (whole KES), phone (normalised 2547…),
 *         callbackUrl, accountReference, transactionDesc }
 *
 * Returns { merchantRequestId, checkoutRequestId, responseCode,
 *           responseDescription, customerMessage }.
 */
async function sendStkPush(env, cfg, pay) {
  const base = darajaBase(cfg.environment);
  const timestamp = formatKenyanTimestamp();
  const password = generateStkPassword(
    cfg.shortcode,
    cfg.passkey,
    timestamp
  );

  const token = await getOAuthToken(env, cfg);

  const isTill =
    String(cfg.shortcodeType || "Till").toLowerCase() === "till";

  // Daraja value truncation rules: AccountReference ≤ 12 chars,
  // TransactionDesc ≤ 13 chars.
  const accountReference =
    String(pay.accountReference || cfg.accountReference || "RetailFlow")
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 12) || "RetailFlow";
  const transactionDesc =
    String(pay.transactionDesc || cfg.transactionDesc || "Payment")
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .slice(0, 13) || "Payment";

  const body = {
    BusinessShortCode: String(cfg.shortcode),
    Password: password,
    Timestamp: timestamp,
    TransactionType: isTill
      ? "CustomerBuyGoodsOnline"
      : "CustomerPayBillOnline",
    Amount: Math.round(Number(pay.amount) || 0),
    PartyA: String(pay.phone),
    PartyB: String(cfg.shortcode),
    PhoneNumber: String(pay.phone),
    CallBackURL: String(
      pay.callbackUrl ||
        cfg.callbackUrl ||
        "https://retailflow-api.princealexdigital.workers.dev/api/mpesa/callback"
    ),
    AccountReference: accountReference,
    TransactionDesc: transactionDesc
  };

  let res;
  try {
    res = await fetch(base + "/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new DarajaError(
      "Unable to reach M-Pesa. Please check your connection and try again.",
      502
    );
  }

  let data = {};
  try {
    data = await res.json();
  } catch (error) {
    throw new DarajaError(
      "M-Pesa returned an unexpected response.",
      502
    );
  }

  // ResponseCode "0" signals that the prompt was accepted and sent.
  const accepted =
    res.ok &&
    (data.ResponseCode === "0" || data.ResponseCode === 0) &&
    data.CheckoutRequestID;

  if (!accepted) {
    throw new DarajaError(
      "Unable to send payment prompt. Please try again.",
      502
    );
  }

  return {
    merchantRequestId: data.MerchantRequestID || "",
    checkoutRequestId: data.CheckoutRequestID || "",
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription || "",
    customerMessage: data.CustomerMessage || ""
  };
}
/**
 * Query the status of an in-flight STK push (used as a
 * reconciliation fallback when a callback has not arrived).
 * Reference: /mpesa/stkpushquery/v1/query
 */
async function queryStkStatus(env, cfg, checkoutRequestId) {
  const base = darajaBase(cfg.environment);
  const timestamp = formatKenyanTimestamp();
  const password = generateStkPassword(
    cfg.shortcode,
    cfg.passkey,
    timestamp
  );
  const token = await getOAuthToken(env, cfg);

  let res;
  try {
    res = await fetch(base + "/mpesa/stkpushquery/v1/query", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        BusinessShortCode: String(cfg.shortcode),
        Password: password,
        Timestamp: timestamp,
        CheckoutRequestID: String(checkoutRequestId)
      })
    });
  } catch (error) {
    throw new DarajaError(
      "Unable to reach M-Pesa while checking payment status.",
      502
    );
  }

  let data = {};
  try {
    data = await res.json();
  } catch (error) {
    throw new DarajaError(
      "M-Pesa returned an unexpected response.",
      502
    );
  }

  return {
    responseCode: data.ResponseCode,
    responseDescription: data.ResponseDescription || "",
    merchantRequestId: data.MerchantRequestID || "",
    checkoutRequestId: data.CheckoutRequestID || ""
  };
}

/**
 * Parse a Daraja STK Push callback body into a safe, structured
 * shape. Throws a DarajaError for malformed callbacks so the public
 * endpoint can still ACK Safaricom without crashing.
 *
 * callback shape (safe, no raw request leak):
 *   { merchantRequestId, checkoutRequestId, resultCode,
 *     resultDescription, amount, mpesaReceiptNumber,
 *     balance, transactionDate, phoneNumber }
 */
function parseStkCallback(raw) {
  const body =
    raw && typeof raw === "object" && raw.Body
      ? raw.Body
      : null;
  const cb =
    body && typeof body.stkCallback === "object"
      ? body.stkCallback
      : null;

  if (!cb || !cb.CheckoutRequestID || cb.ResultCode == null) {
    throw new DarajaError("Invalid M-Pesa callback", 400);
  }

  const items = {};
  if (Array.isArray(cb.CallbackMetadata && cb.CallbackMetadata.Item)) {
    for (const item of cb.CallbackMetadata.Item) {
      if (item && item.Name != null) {
        items[item.Name] = item.Value;
      }
    }
  }

  return {
    merchantRequestId: cb.MerchantRequestID || "",
    checkoutRequestId: cb.CheckoutRequestID,
    resultCode: Number(cb.ResultCode),
    resultDescription: cb.ResultDesc || "",
    amount:
      Number(items.Amount) || 0,
    mpesaReceiptNumber: String(items.MpesaReceiptNumber || ""),
    balance: items.Balance != null ? Number(items.Balance) : null,
    transactionDate: String(items.TransactionDate || ""),
    phoneNumber: String(items.PhoneNumber || "")
  };
}

/*
 * NOTE: This Worker is intentionally SELF-CONTAINED (no external
 * modules). The M-Pesa crypto + Daraja logic is inlined above so the
 * worker can be deployed via wrangler OR pasted into the Cloudflare
 * dashboard single-file editor without missing-module errors. The
 * separate worker/crypto.js and worker/daraja.js files are kept as
 * reference copies for documentation; they are not imported.
 */
const FIREBASE_PROJECT_ID = "retailflow-pos-11726";
const FIREBASE_ISSUER =
  `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/* ================================================================
   RESPONSE HELPERS
   ================================================================ */

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type",
      "Cache-Control": "no-store"
    }
  });
}

function jsonError(message, status = 400) {
  return jsonResponse(
    {
      success: false,
      error: message
    },
    status
  );
}

function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers":
        "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  });
}

/* ================================================================
   ERRORS
   ================================================================ */

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

/* ================================================================
   ID GENERATOR
   ================================================================ */

function generateId(prefix = "id") {
  return `${prefix}_${crypto.randomUUID()}`;
}

/* ================================================================
   FIREBASE ADMIN — server-side account provisioning
   ----------------------------------------------------------------
   Creates Firebase Authentication accounts on behalf of the
   platform owner (e.g. the business administrator created in the
   Add Business flow). Uses Google's Identity Toolkit REST API.

   The Web API key is intentionally NOT a secret — it only identifies
   the Firebase project. Account-write access here is still gated by
   requireRole('owner') further down in the flow.

   URL docs:
     POST https://identitytoolkit.googleapis.com/v1/accounts:signUp
   ================================================================ */

function webApiKey(env) {
  return (
    (env && env.FIREBASE_WEB_API_KEY) ||
    "AIzaSyAUNs3WYS2mkvPvzRDfhyZFUbP2XpZjDQg"
  );
}

function generateTemporaryPassword() {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(
    new Uint8Array(12)
  );
  let pw = "";
  for (let i = 0; i < 12; i++) {
    pw += chars[bytes[i] % chars.length];
  }
  return pw;
}

async function createFirebaseUser(
  email,
  password,
  env
) {
  const res = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" +
      webApiKey(env),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true
      })
    }
  );

  const data = await res.json();

  if (!res.ok || !data.localId) {
    const err = new Error(
      (data &&
        data.error &&
        data.error.message) ||
        "Failed to create Firebase account"
    );
    err.code =
      data && data.error
        ? data.error.code
        : undefined;
    throw err;
  }

  return data; // { localId, idToken, email, ... }
}

async function deleteFirebaseUser(
  idToken,
  env
) {
  try {
    await fetch(
      "https://identitytoolkit.googleapis.com/v1/accounts:delete?key=" +
        webApiKey(env),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          idToken
        })
      }
    );
  } catch (e) {
    console.warn(
      "[RetailFlow] failed to roll back Firebase user:",
      e
    );
  }
}

/* ================================================================
   FIREBASE JWT VERIFICATION
   Native Cloudflare Web Crypto
   No jose dependency
   ================================================================ */

let jwksCache = null;
let jwksCacheTime = 0;

async function getFirebaseKeys() {
  const now = Date.now();

  // Cache Firebase keys for 1 hour
  if (jwksCache && now - jwksCacheTime < 60 * 60 * 1000) {
    return jwksCache;
  }

  const response = await fetch(FIREBASE_JWKS_URL);

  if (!response.ok) {
    throw new Error("Unable to retrieve Firebase public keys");
  }

  jwksCache = await response.json();
  jwksCacheTime = now;

  return jwksCache;
}

function base64UrlDecode(input) {
  let base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (base64.length % 4) {
    base64 += "=";
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function decodeJwtPart(part) {
  const bytes = base64UrlDecode(part);
  return JSON.parse(new TextDecoder().decode(bytes));
}

function base64UrlToUint8Array(input) {
  return base64UrlDecode(input);
}

async function importFirebaseKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );
}

async function verifyFirebaseToken(authHeader) {
  if (
    !authHeader ||
    !authHeader.startsWith("Bearer ")
  ) {
    throw new AuthError(
      "Missing Authorization token",
      401
    );
  }

  const token = authHeader.substring(7).trim();

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new AuthError(
      "Invalid Firebase ID token",
      401
    );
  }

  const [encodedHeader, encodedPayload, encodedSignature] =
    parts;

  let header;
  let payload;

  try {
    header = decodeJwtPart(encodedHeader);
    payload = decodeJwtPart(encodedPayload);
  } catch {
    throw new AuthError(
      "Invalid Firebase ID token",
      401
    );
  }

  if (header.alg !== "RS256") {
    throw new AuthError(
      "Unsupported token algorithm",
      401
    );
  }

  if (!header.kid) {
    throw new AuthError(
      "Firebase token missing key ID",
      401
    );
  }

  const now = Math.floor(Date.now() / 1000);

  if (!payload.sub) {
    throw new AuthError(
      "Firebase token missing user ID",
      401
    );
  }

  if (
    payload.iss !== FIREBASE_ISSUER ||
    payload.aud !== FIREBASE_PROJECT_ID
  ) {
    throw new AuthError(
      "Invalid Firebase token issuer or audience",
      401
    );
  }

  if (!payload.exp || payload.exp < now) {
    throw new AuthError(
      "Firebase token has expired",
      401
    );
  }

  if (payload.iat && payload.iat > now + 60) {
    throw new AuthError(
      "Firebase token issued in the future",
      401
    );
  }

  const keys = await getFirebaseKeys();

  const jwk = keys.keys.find(
    key => key.kid === header.kid
  );

  if (!jwk) {
    // Refresh once in case Google rotated its keys
    jwksCache = null;

    const refreshedKeys = await getFirebaseKeys();

    const refreshedJwk = refreshedKeys.keys.find(
      key => key.kid === header.kid
    );

    if (!refreshedJwk) {
      throw new AuthError(
        "Firebase signing key not found",
        401
      );
    }

    return verifyWithFirebaseKey(
      refreshedJwk,
      encodedHeader,
      encodedPayload,
      encodedSignature,
      payload
    );
  }

  return verifyWithFirebaseKey(
    jwk,
    encodedHeader,
    encodedPayload,
    encodedSignature,
    payload
  );
}

async function verifyWithFirebaseKey(
  jwk,
  encodedHeader,
  encodedPayload,
  encodedSignature,
  payload
) {
  try {
    const key = await importFirebaseKey(jwk);

    const data = new TextEncoder().encode(
      `${encodedHeader}.${encodedPayload}`
    );

    const signature =
      base64UrlToUint8Array(encodedSignature);

    const valid = await crypto.subtle.verify(
      {
        name: "RSASSA-PKCS1-v1_5"
      },
      key,
      signature,
      data
    );

    if (!valid) {
      throw new AuthError(
        "Invalid Firebase token signature",
        401
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    throw new AuthError(
      "Unable to verify Firebase token",
      401
    );
  }
}

/* ================================================================
   USER AUTHORIZATION
   ================================================================ */

async function requireUser(request, env) {
  const firebaseUser = await verifyFirebaseToken(
    request.headers.get("Authorization")
  );

  const firebaseUid = firebaseUser.sub;

  const email =
    String(firebaseUser.email || "")
      .trim()
      .toLowerCase();

  let user = await env.DB.prepare(
    `
    SELECT
      id,
      firebase_uid,
      email,
      name,
      phone,
      role,
      business_id,
      branch_id,
      status,
      last_login,
      created_at
    FROM users
    WHERE firebase_uid = ?
    LIMIT 1
    `
  )
    .bind(firebaseUid)
    .first();

  /*
   * Staff accounts created before the Firebase provisioning flow stored a
   * placeholder `pending:<email>` firebase_uid in D1. When that person
   * signs in with a real Firebase account they won't be found by UID, so
   * fall back to the (Google-verified) email and adopt the real Firebase
   * UID going forward — this also covers records that were written before
   * the provisioning flow existed.
   */
  if (!user && email) {
    user = await env.DB.prepare(
      `
      SELECT
        id,
        firebase_uid,
        email,
        name,
        phone,
        role,
        business_id,
        branch_id,
        status,
        last_login,
        created_at
      FROM users
      WHERE lower(email) = ?
      LIMIT 1
      `
    )
      .bind(email)
      .first();

    if (
      user &&
      (
        !user.firebase_uid ||
        String(user.firebase_uid).startsWith("pending:")
      )
    ) {
      await env.DB.prepare(
        `
        UPDATE users
        SET firebase_uid = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
        .bind(
          firebaseUid,
          new Date().toISOString(),
          user.id
        )
        .run();

      user.firebase_uid = firebaseUid;
    }
  }

  /*
   * Firebase account exists but D1 user record does not.
   */
  if (!user) {
    return {
      id: null,
      firebaseUid,
      email: firebaseUser.email || "",
      name: firebaseUser.name || "",
      phone: "",
      role: "unprovisioned",
      businessId: null,
      branchId: null,
      status: "pending",
      needsOnboarding: true
    };
  }

  /*
   * Status is stored as "Active" / "Suspended" / "Pending" (the admin UI
   * writes the human-readable casing), so compare case-insensitively.
   */
  if (String(user.status || "").toLowerCase() !== "active") {
    throw new AuthError(
      "Your account is not active",
      403
    );
  }

  return {
    id: user.id,
    firebaseUid: user.firebase_uid,
    email: user.email,
    name: user.name || "",
    phone: user.phone || "",
    role: user.role,
    businessId: user.business_id,
    branchId: user.branch_id,
    status: user.status,
    lastLogin: user.last_login,
    needsOnboarding: false
  };
}

/* ================================================================
   ROLE HELPERS
   ================================================================ */

function requireRole(user, roles) {
  if (!roles.includes(user.role)) {
    throw new AuthError(
      "You do not have permission to perform this action",
      403
    );
  }
}

function requireBusinessAccess(user, businessId) {
  if (user.role === "owner") {
    return true;
  }

  if (!user.businessId) {
    throw new AuthError(
      "Your account is not assigned to a business",
      403
    );
  }

  if (user.businessId !== businessId) {
    throw new AuthError(
      "You do not have access to this business",
      403
    );
  }

  return true;
}

function getBusinessId(user, queryBusinessId = null) {
  if (user.role === "owner") {
    return queryBusinessId || null;
  }

  return user.businessId;
}

function getBranchId(user, requestedBranchId = null) {
  if (
    user.role === "owner" ||
    user.role === "admin"
  ) {
    return requestedBranchId || null;
  }

  if (user.branchId) {
    return requestedBranchId || user.branchId;
  }

  return requestedBranchId || null;
}

/* ================================================================
   AUDIT LOG
   ================================================================ */

async function audit(
  env,
  user,
  action,
  businessId = null,
  branchId = null,
  details = null,
  request = null
) {
  try {
    await env.DB.prepare(
      `
      INSERT INTO audit_logs
      (
        id,
        user_id,
        action,
        business_id,
        branch_id,
        details,
        date,
        ip
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        generateId("audit"),
        user?.id || null,
        action,
        businessId,
        branchId,
        details
          ? JSON.stringify(details)
          : null,
        new Date().toISOString(),
        request?.headers.get(
          "CF-Connecting-IP"
        ) || null
      )
      .run();
  } catch (error) {
    console.error(
      "Audit log failed:",
      error
    );
  }
}

/* ================================================================
   AUTH PROFILE
   ================================================================ */

async function getProfile(request, env) {
  const user = await requireUser(
    request,
    env
  );

  return {
    success: true,
    user
  };
}

/* ------------------------------------------------------------------
   BUSINESS-TYPE CONFIGURATION
   Mirrors js/business-types.js server-side so legacy type labels are
   normalised to type codes. The frontend registry remains the full
   source of truth for modules + features; the Worker stores whatever
   the owner picks and only needs to map label → code here.
   ------------------------------------------------------------------ */

const BUSINESS_TYPE_CODE_LABELS = {
  retail: "Retail / Shop", supermarket: "Supermarket", restaurant: "Restaurant",
  cafe: "Café / Coffee Shop", bar: "Bar / Lounge", hotel: "Hotel",
  pharmacy: "Pharmacy", clothing: "Fashion / Clothing", electronics: "Electronics",
  hardware: "Hardware / Building Materials", wholesale: "Wholesale / Distributor",
  salon: "Salon / Barber Shop", laundry: "Laundry / Cleaning", garage: "Auto Parts / Garage",
  agrovet: "Agrovet / Farm Supply", other: "Other Business"
};

function normalizeBusinessType(value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  const map = {
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
  return map[s] || "other";
}

/* ================================================================
   BUSINESSES
   ================================================================ */

async function getBusinesses(request, env) {
  const user = await requireUser(
    request,
    env
  );

  if (user.role === "owner") {
    const { results } =
      await env.DB.prepare(
        `
        SELECT *
        FROM businesses
        ORDER BY created_at DESC
        `
      ).all();

    // Attach safe per-business M-Pesa status (owner view never sees
    // credentials). Failure here is non-fatal — the config table may
    // not exist on a DB that has not run migration 002 yet.
    let businesses = results;
    try {
      const { results: cfgs } = await env.DB.prepare(
        `
        SELECT business_id, enabled, environment,
               shortcode, shortcode_type, connection_status,
               last_connection_test
        FROM mpesa_configurations
        `
      ).all();
      const byBiz = {};
      for (const c of cfgs) {
        byBiz[c.business_id] = c;
      }
      businesses = results.map((b) => {
        const m = byBiz[b.id];
        return m
          ? {
              ...b,
              mpesa: {
                configured: true,
                enabled: mpesaEnabledValue(m.enabled),
                environment: m.environment || "sandbox",
                shortcode: m.shortcode || "",
                shortcodeType: m.shortcode_type || "Till",
                connectionStatus: m.connection_status || "Not Tested",
                lastConnectionTest: m.last_connection_test || null
              }
            }
          : { ...b, mpesa: { configured: false } };
      });
    } catch (error) {
      // Config table unavailable — leave businesses as-is.
    }

    return {
      success: true,
      businesses
    };
  }

  if (!user.businessId) {
    return {
      success: true,
      businesses: []
    };
  }

  const business =
    await env.DB.prepare(
      `
      SELECT *
      FROM businesses
      WHERE id = ?
      `
    )
      .bind(user.businessId)
      .first();

  return {
    success: true,
    businesses: business
      ? [business]
      : []
  };
}

async function getBusiness(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  const business =
    await env.DB.prepare(
      `
      SELECT *
      FROM businesses
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!business) {
    return jsonError(
      "Business not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    id
  );

  return {
    success: true,
    business
  };
}

async function createBusiness(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner"
  ]);

  const body =
    await request.json();

  if (!body.name) {
    return jsonError(
      "Business name is required",
      400
    );
  }

  const id =
    generateId("biz");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO businesses
    (
      id,
      name,
      type,
      type_code,
      phone,
      email,
      address,
      city,
      country,
      reg_no,
      tax_no,
      currency,
      timezone,
      status,
      admin_name,
      admin_email,
      enabled_modules,
      business_features,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      body.name,
      body.type || "Shop",
      body.typeCode
        ? normalizeBusinessType(body.typeCode)
        : normalizeBusinessType(body.type || "Shop"),
      body.phone || null,
      body.email || null,
      body.address || null,
      body.city || null,
      body.country || "Kenya",
      body.regNo || null,
      body.taxNo || null,
      body.currency || "KES",
      body.timezone ||
        "Africa/Nairobi",
      body.status || "Active",
      body.adminName || null,
      body.adminEmail || null,
      Array.isArray(body.enabledModules)
        ? JSON.stringify(body.enabledModules)
        : null,
      body.businessFeatures &&
        typeof body.businessFeatures === "object"
        ? JSON.stringify(body.businessFeatures)
        : null,
      now,
      now
    )
    .run();

  await env.DB.prepare(
    `
    INSERT INTO settings
    (
      business_id
    )
    VALUES (?)
    `
  )
    .bind(id)
    .run();

  await audit(
    env,
    user,
    "business_created",
    id,
    null,
    {
      name: body.name,
      type: body.type,
      typeCode: body.typeCode || null
    },
    request
  );

  const business =
    await env.DB.prepare(
      `
      SELECT *
      FROM businesses
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  return {
    success: true,
    business
  };
}

async function updateBusiness(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin"
  ]);

  const business =
    await env.DB.prepare(
      `
      SELECT *
      FROM businesses
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!business) {
    return jsonError(
      "Business not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    id
  );

  const body =
    await request.json();

  await env.DB.prepare(
    `
    UPDATE businesses
    SET
      name = ?,
      type = ?,
      type_code = ?,
      phone = ?,
      email = ?,
      address = ?,
      city = ?,
      country = ?,
      reg_no = ?,
      tax_no = ?,
      currency = ?,
      timezone = ?,
      status = ?,
      admin_name = ?,
      admin_email = ?,
      enabled_modules = ?,
      business_features = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      body.name ?? business.name,
      body.type ?? (body.typeCode ? (BUSINESS_TYPE_CODE_LABELS[normalizeBusinessType(body.typeCode)] || business.type) : business.type),
      normalizeBusinessType(body.typeCode ?? business.type_code ?? body.type ?? business.type),
      body.phone ?? business.phone,
      body.email ?? business.email,
      body.address ?? business.address,
      body.city ?? business.city,
      body.country ?? business.country,
      body.regNo ?? business.reg_no,
      body.taxNo ?? business.tax_no,
      body.currency ?? business.currency,
      body.timezone ?? business.timezone,
      body.status ?? business.status,
      body.adminName ??
        business.admin_name,
      body.adminEmail ??
        business.admin_email,
      Array.isArray(body.enabledModules)
        ? JSON.stringify(body.enabledModules)
        : (body.enabledModules === null ? null : business.enabled_modules),
      body.businessFeatures &&
        typeof body.businessFeatures === "object"
        ? JSON.stringify(body.businessFeatures)
        : (body.businessFeatures === null ? null : business.business_features),
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "business_updated",
    id,
    null,
    body,
    request
  );

  return getBusiness(
    request,
    env,
    id
  );
}

/* ================================================================
   BRANCHES
   ================================================================ */

async function getBranches(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      branches: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const { results } =
    await env.DB.prepare(
      `
      SELECT *
      FROM branches
      WHERE business_id = ?
      ORDER BY created_at DESC
      `
    )
      .bind(businessId)
      .all();

  return {
    success: true,
    branches: results
  };
}

async function createBranch(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  if (!body.name) {
    return jsonError(
      "Branch name is required",
      400
    );
  }

  const id =
    generateId("branch");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO branches
    (
      id,
      business_id,
      name,
      code,
      location,
      phone,
      email,
      manager,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      businessId,
      body.name,
      body.code || null,
      body.location || null,
      body.phone || null,
      body.email || null,
      body.manager || null,
      body.status || "Active",
      now,
      now
    )
    .run();

  await audit(
    env,
    user,
    "branch_created",
    businessId,
    id,
    Object.assign({}, body, { branchId: id }),
    request
  );

  return {
    success: true,
    branch:
      await env.DB.prepare(
        `
        SELECT *
        FROM branches
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

async function updateBranch(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin"
  ]);

  const branch =
    await env.DB.prepare(
      `
      SELECT *
      FROM branches
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!branch) {
    return jsonError(
      "Branch not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    branch.business_id
  );

  const body =
    await request.json();

  await env.DB.prepare(
    `
    UPDATE branches
    SET
      name = ?,
      code = ?,
      location = ?,
      phone = ?,
      email = ?,
      manager = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      body.name ?? branch.name,
      body.code ?? branch.code,
      body.location ??
        branch.location,
      body.phone ?? branch.phone,
      body.email ?? branch.email,
      body.manager ??
        branch.manager,
      body.status ?? branch.status,
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "branch_updated",
    branch.business_id,
    id,
    body,
    request
  );

  return {
    success: true,
    branch:
      await env.DB.prepare(
        `
        SELECT *
        FROM branches
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   STAFF
   ================================================================ */

async function getStaff(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      staff: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  let sql = `
    SELECT
      id,
      firebase_uid,
      email,
      name,
      phone,
      role,
      business_id,
      branch_id,
      status,
      last_login,
      created_at,
      updated_at
    FROM users
    WHERE business_id = ?
  `;

  const params = [
    businessId
  ];

  const branchId =
    query.get("branchId");

  if (branchId) {
    sql +=
      " AND branch_id = ?";
    params.push(branchId);
  }

  const role =
    query.get("role");

  if (role) {
    sql +=
      " AND role = ?";
    params.push(role);
  }

  sql +=
    " ORDER BY created_at DESC";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    staff: results
  };
}

async function createStaff(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  if (!body.email) {
    return jsonError(
      "Email is required",
      400
    );
  }

  /* Resolve the Firebase UID.
     - New staff without a UID (or staff created before the provisioning
       flow who carry a "pending:" placeholder) get a real Firebase
       Authentication account created right here using the temporary
       password supplied by the caller.
     - The Worker always stores the real Firebase UID in D1. */
  let firebaseUid = body.firebaseUid;
  let provisionedToken = null;

  if (
    !firebaseUid ||
    String(firebaseUid).startsWith("pending:")
  ) {
    if (!body.password) {
      return jsonError(
        "Temporary password is required to create the Firebase account",
        400
      );
    }

    try {
      const fb = await createFirebaseUser(
        body.email,
        body.password,
        env
      );
      firebaseUid = fb.localId;
      provisionedToken = fb.idToken;
    } catch (fbErr) {
      const code = fbErr && fbErr.code;
      if (
        code === "EMAIL_EXISTS" ||
        code === "EMAIL_NOT_FOUND"
      ) {
        return jsonError(
          "A Firebase account already exists for this email",
          409
        );
      }
      if (code === "INVALID_EMAIL") {
        return jsonError(
          "The email address is not valid",
          400
        );
      }
      if (code === "WEAK_PASSWORD") {
        return jsonError(
          "The password is too weak — use at least 6 characters",
          400
        );
      }
      return jsonError(
        (fbErr && fbErr.message) ||
          "Failed to create Firebase account",
        400
      );
    }
  }

  const allowedRoles = [
    "admin",
    "store_manager",
    "cashier",
    "inventory_manager",
    "accountant",
    "waiter",
    "sales_staff",
    "custom"
  ];

  const role =
    body.role || "cashier";

  if (!allowedRoles.includes(role)) {
    return jsonError(
      "Invalid staff role",
      400
    );
  }

  const existingByUid =
    await env.DB.prepare(
      `
      SELECT id
      FROM users
      WHERE firebase_uid = ?
      `
    )
      .bind(firebaseUid)
      .first();

  if (existingByUid) {
    return jsonError(
      "This Firebase account is already registered",
      409
    );
  }

  const existingByEmail =
    await env.DB.prepare(
      `
      SELECT id
      FROM users
      WHERE email = ?
      `
    )
      .bind(body.email)
      .first();

  if (existingByEmail) {
    return jsonError(
      "A staff member with this email already exists",
      409
    );
  }

  const id =
    generateId("user");

  const now =
    new Date().toISOString();

  try {
    await env.DB.prepare(
      `
      INSERT INTO users
      (
        id,
        firebase_uid,
        email,
        name,
        phone,
        role,
        business_id,
        branch_id,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        id,
        firebaseUid,
        body.email,
        body.name || "",
        body.phone || null,
        role,
        businessId,
        body.branchId || null,
        body.status || "active",
        now,
        now
      )
      .run();

    await audit(
      env,
      user,
      "staff_created",
      businessId,
      body.branchId || null,
      {
        staffId: id,
        name: body.name,
        email: body.email,
        role
      },
      request
    );

    return {
      success: true,
      staff:
        await env.DB.prepare(
          `
          SELECT *
          FROM users
          WHERE id = ?
          `
        )
          .bind(id)
          .first()
    };
  } catch (dbErr) {
    // Roll back anything we may have created so the system never keeps an
    // orphan auth account or half-written D1 record.
    try {
      await env.DB.prepare(
        `
        DELETE FROM users
        WHERE id = ?
        `
      )
        .bind(id)
        .run();
    } catch (e) {
      // best-effort cleanup
    }
    if (provisionedToken) {
      await deleteFirebaseUser(
        provisionedToken,
        env
      );
    }
    throw dbErr;
  }
}

async function updateStaff(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin"
  ]);

  const staff =
    await env.DB.prepare(
      `
      SELECT *
      FROM users
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!staff) {
    return jsonError(
      "Staff member not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    staff.business_id
  );

  const body =
    await request.json();

  const allowedRoles = [
    "admin",
    "store_manager",
    "cashier",
    "inventory_manager",
    "accountant",
    "waiter",
    "sales_staff",
    "custom"
  ];

  if (
    body.role &&
    !allowedRoles.includes(
      body.role
    )
  ) {
    return jsonError(
      "Invalid staff role",
      400
    );
  }

  await env.DB.prepare(
    `
    UPDATE users
    SET
      name = ?,
      phone = ?,
      role = ?,
      branch_id = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      body.name ?? staff.name,
      body.phone ?? staff.phone,
      body.role ?? staff.role,
      body.branchId ??
        staff.branch_id,
      body.status ??
        staff.status,
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "staff_updated",
    staff.business_id,
    body.branchId ??
      staff.branch_id,
    {
      staffId: id
    },
    request
  );

  return {
    success: true,
    staff:
      await env.DB.prepare(
        `
        SELECT *
        FROM users
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   PRODUCTS
   ================================================================ */

async function getProducts(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      products: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const branchId =
    getBranchId(
      user,
      query.get("branchId")
    );

  let sql = `
    SELECT *
    FROM products
    WHERE business_id = ?
  `;

  const params = [
    businessId
  ];

  if (branchId) {
    sql += `
      AND (
        branch_id = ?
        OR branch_id IS NULL
      )
    `;

    params.push(branchId);
  }

  const search =
    query.get("search");

  if (search) {
    sql += `
      AND (
        name LIKE ?
        OR sku LIKE ?
        OR barcode LIKE ?
      )
    `;

    const value =
      `%${search}%`;

    params.push(
      value,
      value,
      value
    );
  }

  const category =
    query.get("category");

  if (category) {
    sql +=
      " AND category = ?";
        params.push(category);
  }

  // Exclude archived products from POS
  sql +=
    " AND status != 'Archived' ORDER BY created_at DESC";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    products: results
  };
}

async function createProduct(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "inventory_manager"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const id =
    generateId("product");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO products
    (
      id,
      business_id,
      branch_id,
      name,
      sku,
      barcode,
      category,
      brand,
      cost_price,
      selling_price,
      offer_price,
      stock,
      reorder_level,
      unit,
      product_type,
      tax,
      status,
      image,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      businessId,
      body.branchId || null,
      body.name,
      body.sku || null,
      body.barcode || null,
      body.category || null,
      body.brand || null,
      Number(body.costPrice || 0),
      Number(body.sellingPrice || 0),
      Number(body.offerPrice || 0),
      Number(body.stock || 0),
      Number(body.reorderLevel || 0),
      body.unit || "pcs",
      body.productType || "product",
      body.tax ? 1 : 0,
      body.status || "Active",
      body.image || null,
      now,
      now
    )
    .run();

  await audit(
    env,
    user,
    "product_created",
    businessId,
    body.branchId || null,
    {
      productId: id,
      name: body.name
    },
    request
  );

  return {
    success: true,
    product:
      await env.DB.prepare(
        `
        SELECT *
        FROM products
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

async function updateProduct(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "inventory_manager"
  ]);

  const product =
    await env.DB.prepare(
      `
      SELECT *
      FROM products
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!product) {
    return jsonError(
      "Product not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    product.business_id
  );

  if (
    user.role ===
      "store_manager" &&
    product.branch_id &&
    product.branch_id !==
      user.branchId
  ) {
    throw new AuthError(
      "You cannot modify this branch's product",
      403
    );
  }

  const body =
    await request.json();

  await env.DB.prepare(
    `
    UPDATE products
    SET
      branch_id = ?,
      name = ?,
      sku = ?,
      barcode = ?,
      category = ?,
      brand = ?,
      cost_price = ?,
      selling_price = ?,
      offer_price = ?,
      stock = ?,
      reorder_level = ?,
      unit = ?,
      product_type = ?,
      tax = ?,
      status = ?,
      image = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      body.branchId ??
        product.branch_id,
      body.name ?? product.name,
      body.sku ?? product.sku,
      body.barcode ??
        product.barcode,
      body.category ??
        product.category,
      body.brand ??
        product.brand,
      Number(
        body.costPrice ??
          product.cost_price
      ),
      Number(
        body.sellingPrice ??
          product.selling_price
      ),
      Number(
        body.offerPrice ??
          product.offer_price
      ),
      Number(
        body.stock ??
          product.stock
      ),
      Number(
        body.reorderLevel ??
          product.reorder_level
      ),
      body.unit ?? product.unit,
      body.productType ?? product.product_type,
      body.tax !== undefined
        ? body.tax
          ? 1
          : 0
        : product.tax,
      body.status ??
        product.status,
      body.image ??
        product.image,
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "product_updated",
    product.business_id,
    product.branch_id,
    {
      productId: id
    },
    request
  );

  return {
    success: true,
    product:
      await env.DB.prepare(
        `
        SELECT *
        FROM products
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   INVENTORY
   ================================================================ */

async function adjustInventory(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "inventory_manager"
  ]);

  const body =
    await request.json();

  const product =
    await env.DB.prepare(
      `
      SELECT *
      FROM products
      WHERE id = ?
      `
    )
      .bind(body.productId)
      .first();

  if (!product) {
    return jsonError(
      "Product not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    product.business_id
  );

  if (
    user.role ===
      "store_manager" &&
    product.branch_id &&
    product.branch_id !==
      user.branchId
  ) {
    throw new AuthError(
      "You cannot modify this branch's inventory",
      403
    );
  }

  const quantity =
    Number(body.quantity || 0);

  const type =
    body.type || "adjustment";

  let newStock;

  if (
    body.newStockLevel !==
    undefined
  ) {
    newStock =
      Number(body.newStockLevel);
  } else if (
    type === "stock_out"
  ) {
    newStock =
      Number(product.stock) -
      Math.abs(quantity);
  } else {
    newStock =
      Number(product.stock) +
      quantity;
  }

  if (newStock < 0) {
    return jsonError(
      "Stock cannot be negative",
      400
    );
  }

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    UPDATE products
    SET
      stock = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      newStock,
      now,
      body.productId
    )
    .run();

  await env.DB.prepare(
    `
    INSERT INTO stock_movements
    (
      id,
      product_id,
      business_id,
      branch_id,
      type,
      quantity,
      reason,
      reference_id,
      created_by,
      date
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      generateId("stock"),
      product.id,
      product.business_id,
      product.branch_id,
      type,
      quantity,
      body.reason ||
        "Inventory adjustment",
      body.referenceId || null,
      user.id,
      now
    )
    .run();

  await audit(
    env,
    user,
    "inventory_adjusted",
    product.business_id,
    product.branch_id,
    {
      productId:
        product.id,
      previousStock:
        product.stock,
      newStock,
      quantity,
      type
    },
    request
  );

  return {
    success: true,
    product:
      await env.DB.prepare(
        `
        SELECT *
        FROM products
        WHERE id = ?
        `
      )
        .bind(product.id)
        .first()
  };
}

async function getInventory(
  request,
  env,
  query
) {
  return getProducts(
    request,
    env,
    query
  );
}

/* ================================================================
   SALES
   ================================================================ */

async function getSales(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      sales: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const branchId =
    getBranchId(
      user,
      query.get("branchId")
    );

  let sql = `
    SELECT
      s.*,
      b.name AS business_name,
      br.name AS branch_name,
      c.name AS customer_name,
      u.name AS cashier_name,
      m.mpesa_receipt_number
    FROM sales s
    LEFT JOIN businesses b
      ON s.business_id = b.id
    LEFT JOIN branches br
      ON s.branch_id = br.id
    LEFT JOIN customers c
      ON s.customer_id = c.id
    LEFT JOIN users u
      ON s.cashier_id = u.id
    LEFT JOIN mpesa_transactions m
      ON m.sale_id = s.id
    WHERE s.business_id = ?
  `;

  const params = [
    businessId
  ];

  if (branchId) {
    sql +=
      " AND s.branch_id = ?";
    params.push(branchId);
  }

  const status =
    query.get("status");

  if (status) {
    sql +=
      " AND s.status = ?";
    params.push(status);
  }

  const from =
    query.get("from");

  if (from) {
    sql +=
      " AND date(s.date) >= ?";
    params.push(from);
  }

  const to =
    query.get("to");

  if (to) {
    sql +=
      " AND date(s.date) <= ?";
    params.push(to);
  }

  sql +=
    " ORDER BY s.created_at DESC LIMIT 500";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    sales: results
  };
}

/* ================================================================
   REFUND REQUESTS
   Cashiers submit requests; owner/admin/store_manager approve or
   reject. Approval flips the sale to "Refunded", restores stock
   and walks back customer totals.
   ================================================================ */

function mapRefundRequestRow(r) {
  return {
    id: r.id,
    businessId: r.business_id,
    branchId: r.branch_id,
    saleId: r.sale_id,
    receiptNumber: r.receipt_number,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name || null,
    amount: r.amount,
    reason: r.reason,
    status: r.status || "Pending",
    decidedBy: r.decided_by,
    decidedByName: r.decided_by_name || null,
    decidedAt: r.decided_at,
    decisionNotes: r.decision_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

async function getRefundRequests(request, env, query) {
  const user = await requireUser(request, env);

  let businessId = query.get("businessId");

  if (user.role !== "owner") {
    businessId = user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      requests: []
    };
  }

  requireBusinessAccess(user, businessId);

  const branchId =
    getBranchId(user, query.get("branchId"));

  let sql = `
    SELECT
      rr.*,
      u.name AS requested_by_name,
      d.name AS decided_by_name
    FROM refund_requests rr
    LEFT JOIN users u
      ON rr.requested_by = u.id
    LEFT JOIN users d
      ON rr.decided_by = d.id
    WHERE rr.business_id = ?
  `;

  const params = [businessId];

  if (branchId) {
    sql += " AND rr.branch_id = ?";
    params.push(branchId);
  }

  sql += " ORDER BY rr.created_at DESC LIMIT 300";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    requests: (results || []).map(mapRefundRequestRow)
  };
}

async function createRefundRequest(request, env) {
  const user = await requireUser(request, env);

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "cashier",
    "sales_staff",
    "waiter"
  ]);

  const body = await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError("Business ID is required", 400);
  }

  requireBusinessAccess(user, businessId);

  if (!body.saleId) {
    return jsonError("Sale ID is required", 400);
  }

  const reason =
    String(body.reason || "").trim();

  if (!reason) {
    return jsonError("A refund reason is required", 400);
  }

  const sale =
    await env.DB.prepare(
      `SELECT * FROM sales WHERE id = ? AND business_id = ?`
    )
      .bind(body.saleId, businessId)
      .first();

  if (!sale) {
    return jsonError("Sale not found", 404);
  }

  if (sale.status === "Refunded") {
    return jsonError("This sale has already been refunded", 409);
  }

  /*
   * Only one open request per sale — prevents
   * duplicate approvals and double refunds.
   */

  const pending =
    await env.DB.prepare(
      `SELECT id FROM refund_requests WHERE sale_id = ? AND status = 'Pending' LIMIT 1`
    )
      .bind(sale.id)
      .first();

  if (pending) {
    return jsonError("A refund request for this sale is already awaiting approval", 409);
  }

  let amount =
    body.amount != null
      ? Math.round(Number(body.amount) * 100) / 100
      : Math.round(Number(sale.total || 0) * 100) / 100;

  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonError("Invalid refund amount", 400);
  }

  if (amount > Number(sale.total || 0)) {
    amount = Math.round(Number(sale.total || 0) * 100) / 100;
  }

  const branchId =
    sale.branch_id || user.branchId || null;

  const now =
    new Date().toISOString();

  const refundId =
    generateId("refund");

  await env.DB.prepare(
    `
    INSERT INTO refund_requests
    (
      id,
      business_id,
      branch_id,
      sale_id,
      receipt_number,
      requested_by,
      amount,
      reason,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
    `
  )
    .bind(
      refundId,
      businessId,
      branchId,
      sale.id,
      sale.receipt_number,
      user.id,
      amount,
      reason.slice(0, 500),
      now,
      now
    )
    .run();

  await audit(
    env,
    user,
    "Refund requested",
    businessId,
    branchId,
    { refundRequestId: refundId, saleId: sale.id, amount: amount },
    request
  );

  return {
    success: true,
    request: mapRefundRequestRow({
      id: refundId,
      business_id: businessId,
      branch_id: branchId,
      sale_id: sale.id,
      receipt_number: sale.receipt_number,
      requested_by: user.id,
      amount: amount,
      reason: reason.slice(0, 500),
      status: "Pending",
      created_at: now,
      updated_at: now
    })
  };
}
/*
 * Approve or reject a refund request. Only owner, admin and
 * store_manager may decide. Approving flips the sale to
 * "Refunded", restores product stock (stock_in movements) and
 * walks back the customer's total purchases.
 */

async function decideRefundRequest(
  request,
  env,
  refundId
) {
  const user = await requireUser(request, env);

  requireRole(user, [
    "owner",
    "admin",
    "store_manager"
  ]);

  const body = await request.json();

  const decision =
    String(body.decision || "").trim();

  if (
    decision !== "Approved" &&
    decision !== "Rejected"
  ) {
    return jsonError(
      "Decision must be 'Approved' or 'Rejected'",
      400
    );
  }

  const rr = await env.DB.prepare(
    `SELECT * FROM refund_requests WHERE id = ?`
  )
    .bind(refundId)
    .first();

  if (!rr) {
    return jsonError("Refund request not found", 404);
  }

  requireBusinessAccess(user, rr.business_id);

  /*
   * A store manager may only decide on refunds
   * raised within their own branch.
   */

  if (
    user.role === "store_manager" &&
    rr.branch_id &&
    rr.branch_id !== user.branchId
  ) {
    throw new AuthError(
      "You cannot decide on refunds for another branch",
      403
    );
  }

  if (rr.status !== "Pending") {
    return jsonError(
      "This refund request has already been decided",
      409
    );
  }

  const sale = await env.DB.prepare(
    `SELECT * FROM sales WHERE id = ?`
  )
    .bind(rr.sale_id)
    .first();

  if (!sale) {
    return jsonError("Sale not found", 404);
  }

  const now = new Date().toISOString();

  const notes = body.notes
    ? String(body.notes).slice(0, 500)
    : null;

  if (decision === "Approved") {
    if (sale.status === "Refunded") {
      return jsonError(
        "This sale has already been refunded",
        409
      );
    }

    await env.DB.prepare(
      `
      UPDATE sales
      SET
        status = 'Refunded',
        updated_at = ?
      WHERE id = ?
      `
    )
      .bind(now, sale.id)
      .run();

    /*
     * Restore stock for every line on the sale.
     * Sale items are stored as a JSON string of
     * { productId, quantity, ... } rows.
     */

    let items = sale.items;
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch (e) { items = []; }
    }
    if (!Array.isArray(items)) items = [];

    for (const item of items) {
      const productId = item.productId || item.id;
      const quantity = Math.abs(
        Number(item.quantity) || 0
      );

      if (!productId || quantity <= 0) continue;

      await env.DB.prepare(
        `
        UPDATE products
        SET
          stock = stock + ?,
          updated_at = ?
        WHERE id = ?
        AND business_id = ?
        `
      )
        .bind(quantity, now, productId, rr.business_id)
        .run();

      await env.DB.prepare(
        `
        INSERT INTO stock_movements
        (
          id,
          product_id,
          business_id,
          branch_id,
          type,
          quantity,
          reason,
          reference_id,
          created_by,
          date
        )
        VALUES (?, ?, ?, ?, 'stock_in', ?, 'POS Refund', ?, ?, ?)
        `
      )
        .bind(
          generateId("stock"),
          productId,
          rr.business_id,
          sale.branch_id || rr.branch_id || null,
          quantity,
          refundId,
          user.id,
          now
        )
        .run();
    }

    /*
     * Walk back the customer's purchase totals.
     * MAX() keeps the total from going negative
     * if the customer record was edited manually.
     */

    if (sale.customer_id) {
      const walkBack = Math.min(
        Number(rr.amount) || 0,
        Number(sale.total) || 0
      );

      await env.DB.prepare(
        `
        UPDATE customers
        SET
          total_purchases =
            MAX(total_purchases - ?, 0),
          updated_at = ?
        WHERE id = ?
        AND business_id = ?
        `
      )
        .bind(
          walkBack,
          now,
          sale.customer_id,
          rr.business_id
        )
        .run();
    }
  }

  await env.DB.prepare(
    `
    UPDATE refund_requests
    SET
      status = ?,
      decided_by = ?,
      decided_at = ?,
      decision_notes = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      decision,
      user.id,
      now,
      notes,
      now,
      refundId
    )
    .run();

  await audit(
    env,
    user,
    decision === "Approved"
      ? "Refund approved"
      : "Refund rejected",
    rr.business_id,
    rr.branch_id,
    {
      refundRequestId: refundId,
      saleId: rr.sale_id,
      amount: rr.amount,
      notes: notes
    },
    request
  );

  const updated = await env.DB.prepare(
    `
    SELECT
      rr.*,
      u.name AS requested_by_name,
      d.name AS decided_by_name
    FROM refund_requests rr
    LEFT JOIN users u
      ON rr.requested_by = u.id
    LEFT JOIN users d
      ON rr.decided_by = d.id
    WHERE rr.id = ?
    `
  )
    .bind(refundId)
    .first();

  return {
    success: true,
    request: mapRefundRequestRow(updated || rr)
  };
}

/* ================================================================
   CREATE SALE
   ================================================================ */

async function createSale(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "cashier",
    "sales_staff",
    "waiter"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const branchId =
    body.branchId ||
    user.branchId ||
    null;

  if (
    user.role ===
      "store_manager" &&
    branchId !==
      user.branchId
  ) {
    throw new AuthError(
      "You cannot make sales for another branch",
      403
    );
  }

  if (
    user.role === "cashier" &&
    user.branchId &&
    branchId !==
      user.branchId
  ) {
    throw new AuthError(
      "Invalid branch",
      403
    );
  }

  const items =
    Array.isArray(body.items)
      ? body.items
      : [];

  if (!items.length) {
    return jsonError(
      "Sale must contain at least one item",
      400
    );
  }

  const now =
    new Date().toISOString();

  /*
   * Load business settings — tax + discount
   * configuration comes from the database,
   * never from the client.
   */

  let settings =
    await env.DB.prepare(
      `
      SELECT *
      FROM settings
      WHERE business_id = ?
      `
    )
      .bind(businessId)
      .first();

  if (!settings) {
    await env.DB.prepare(
      `
      INSERT INTO settings
      (
        business_id
      )
      VALUES (?)
      `
    )
      .bind(businessId)
      .run();

    settings =
      await env.DB.prepare(
        `
        SELECT *
        FROM settings
        WHERE business_id = ?
        `
      )
        .bind(businessId)
        .first();
  }

  const taxEnabled =
    Number(
      settings &&
      settings.enable_tax
    ) === 1;

  const taxRatePct =
    taxEnabled &&
    settings.tax_rate != null
      ? Number(settings.tax_rate)
      : 0;

  const discountsEnabled = !(
    settings &&
    Number(settings.enable_discounts) === 0
  );

  const canDiscount =
    discountsEnabled &&
    [
      "owner",
      "admin",
      "store_manager"
    ].includes(user.role);

  /*
   * Validate the customer belongs to
   * this business.
   */

  const customerId =
    body.customerId || null;

  if (customerId) {
    const customer =
      await env.DB.prepare(
        `
        SELECT id
        FROM customers
        WHERE id = ?
        AND business_id = ?
        `
      )
        .bind(customerId, businessId)
        .first();

    if (!customer) {
      return jsonError(
        "Customer not found",
        404
      );
    }
  }

  /*
   * Authoritative pricing — every line is
   * re-resolved from D1. Client-supplied
   * prices, taxes and totals are ignored.
   */

  const resolved = [];
  let subtotal = 0;
  let taxTotal = 0;

  for (const item of items) {
    if (!item.productId) {
      continue;
    }

    const qty =
      Math.floor(
        Number(item.quantity || 0)
      );

    if (qty <= 0) {
      return jsonError(
        "Invalid product quantity",
        400
      );
    }

    const product =
      await env.DB.prepare(
        `
        SELECT *
        FROM products
        WHERE id = ?
        AND business_id = ?
        `
      )
        .bind(
          item.productId,
          businessId
        )
        .first();

    if (!product) {
      return jsonError(
        `Product not found: ${item.name || item.productId}`,
        404
      );
    }

    if (
      product.branch_id &&
      branchId &&
      product.branch_id !== branchId
    ) {
      return jsonError(
        `Product not available at this branch: ${product.name}`,
        403
      );
    }

    if (
      String(product.status || "Active").toLowerCase() !==
      "active"
    ) {
      return jsonError(
        `Product is not available for sale: ${product.name}`,
        409
      );
    }

    if (
      Number(product.stock) <
      qty
    ) {
      return jsonError(
        `Insufficient stock for ${product.name}`,
        400
      );
    }

    const unitPrice =
      Number(product.selling_price || 0);

    // Use offer price if available and valid
    const offerPrice = Number(product.offer_price || 0);
    const effectivePrice = (offerPrice > 0 && offerPrice < unitPrice) ? offerPrice : unitPrice;
    const hasOffer = effectivePrice < unitPrice;
    const savings = hasOffer ? Math.round((unitPrice - effectivePrice) * 100) / 100 : 0;

    const lineTotal =
      Math.round(effectivePrice * qty * 100) / 100;

    // Tax is INCLUSIVE: extract tax from selling price
    // Formula: tax = price * rate / (100 + rate)
    const lineTax = product.tax && taxRatePct > 0
      ? Math.round(lineTotal * taxRatePct * 100) / ((100 + taxRatePct) * 100)
      : 0;

    subtotal += lineTotal;
    taxTotal += lineTax;

    resolved.push({
      productId: product.id,
      name: product.name,
      sku: product.sku || null,
      quantity: qty,
      price: effectivePrice,
      originalPrice: unitPrice,
      total: lineTotal,
      hasOffer,
      savings
    });
  }

  if (!resolved.length) {
    return jsonError(
      "Sale must contain at least one valid item",
      400
    );
  }

  subtotal =
    Math.round(subtotal * 100) / 100;

  taxTotal =
    Math.round(taxTotal * 100) / 100;

  /*
   * Discount — capped and permission-checked.
   */

  let discount = 0;

  if (canDiscount && body.discount != null) {
    const raw =
      Number(body.discount);

    if (
      !Number.isFinite(raw) ||
      raw < 0
    ) {
      return jsonError(
        "Invalid discount",
        400
      );
    }

    discount =
      body.discountType === "percent"
        ? Math.round(
            subtotal *
            Math.min(raw, 100)
          ) / 100
        : Math.min(
            Math.round(raw * 100) / 100,
            subtotal
          );
  }

  if (discount > subtotal) {
    discount = subtotal;
  }

  // Tax is INCLUSIVE: already included in selling price
  // Total = subtotal - discount (tax is already in subtotal)
  const total =
    Math.round(
      (subtotal - discount) * 100
    ) / 100;

  /*
   * Payment — the method must be enabled in
   * business settings.
   */

  const paymentMethod =
    String(body.paymentMethod || "Cash");

  let allowedMethods = [
    "Cash",
    "M-Pesa",
    "Card"
  ];

  try {
    if (settings && settings.payment_methods) {
      allowedMethods =
        JSON.parse(settings.payment_methods);
    }
  } catch (e) { }

  if (allowedMethods.indexOf(paymentMethod) === -1) {
    return jsonError(
      `Unsupported payment method: ${paymentMethod}`,
      400
    );
  }

  const notes =
    body.notes
      ? String(body.notes).slice(0, 500)
      : null;

  const amount =
    body.amount != null
      ? Math.round(Number(body.amount) * 100) / 100
      : total;

  // Use epsilon comparison to avoid floating-point precision issues
  const epsilon = 0.001;
  if (
    !Number.isFinite(amount) ||
    (amount + epsilon) < total
  ) {
    return jsonError(
      "Amount received is less than the total due",
      422
    );
  }

  const changeAmount =
    Math.round((amount - total) * 100) / 100;

  /*
   * Receipt number — use the one generated by the POS client.
   * The POS applies the business's receipt-numbering settings
   * (prefix, format, padding) so the server just persists it.
   * Fall back to a timestamp-based number if the client didn't send one.
   */

  const receiptNumber =
    (body.receiptNumber || "").slice(0, 50) ||
    `RF-${Date.now()}`;

  const saleId =
    generateId("sale");

  await env.DB.prepare(
    `
    INSERT INTO sales
    (
      id,
      business_id,
      branch_id,
      cashier_id,
      customer_id,
      receipt_number,
      date,
      items,
      subtotal,
      tax,
      discount,
      total,
      amount,
      change_amount,
      payment_method,
      status,
      notes,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      saleId,
      businessId,
      branchId,
      user.id,
      customerId,
      receiptNumber,
      now,
      JSON.stringify(resolved),
      subtotal,
      taxTotal,
      discount,
      total,
      amount,
      changeAmount,
      paymentMethod,
      "Completed",
      notes,
      now,
      now
    )
    .run();

  /*
   * Update inventory — guarded decrement
   * (stock only goes down if it is still
   * sufficient) + stock movement record.
   */

  for (const item of resolved) {
    await env.DB.prepare(
      `
      UPDATE products
      SET
        stock = stock - ?,
        updated_at = ?
      WHERE id = ?
      AND business_id = ?
      AND stock >= ?
      `
    )
      .bind(
        item.quantity,
        now,
        item.productId,
        businessId,
        item.quantity
      )
      .run();

    await env.DB.prepare(
      `
      INSERT INTO stock_movements
      (
        id,
        product_id,
        business_id,
        branch_id,
        type,
        quantity,
        reason,
        reference_id,
        created_by,
        date
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
      .bind(
        generateId("stock"),
        item.productId,
        businessId,
        branchId,
        "stock_out",
        item.quantity,
        "POS Sale",
        saleId,
        user.id,
        now
      )
      .run();
  }

  /*
   * Update customer totals.
   */

  if (body.customerId) {
    await env.DB.prepare(
      `
      UPDATE customers
      SET
        total_purchases =
          total_purchases + ?,
        updated_at = ?
      WHERE id = ?
      AND business_id = ?
      `
    )
      .bind(
        total,
        now,
        customerId,
        businessId
      )
      .run();
  }

  await audit(
    env,
    user,
    "sale_created",
    businessId,
    branchId,
    {
      saleId,
      receiptNumber,
      total,
      paymentMethod
    },
    request
  );

  return {
    success: true,
    sale: {
      id: saleId,
      receiptNumber,
      businessId,
      branchId,
      customerId,
      date: now,
      items: resolved,
      subtotal,
      tax: taxTotal,
      discount,
      total,
      amount,
      changeAmount,
      paymentMethod,
      status: "Completed"
    }
  };
}

/* ================================================================
   PURCHASES
   ================================================================ */

async function getPurchases(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      purchases: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  let sql = `
    SELECT
      p.*,
      s.name AS supplier_name
    FROM purchases p
    LEFT JOIN suppliers s
      ON p.supplier_id = s.id
    WHERE p.business_id = ?
  `;

  const params = [
    businessId
  ];

  const branchId =
    query.get("branchId");

  if (branchId) {
    sql +=
      " AND p.branch_id = ?";
    params.push(branchId);
  }

  sql +=
    " ORDER BY p.created_at DESC";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    purchases: results
  };
}

async function createPurchase(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "inventory_manager"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const id =
    generateId("purchase");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO purchases
    (
      id,
      business_id,
      branch_id,
      supplier_id,
      supplier_name,
      date,
      items,
      subtotal,
      tax,
      total,
      status,
      payment_method,
      notes,
      created_by,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      businessId,
      body.branchId ||
        user.branchId ||
        null,
      body.supplierId || null,
      body.supplierName || null,
      body.date ||
        now.slice(0, 10),
      JSON.stringify(
        body.items || []
      ),
      Number(
        body.subtotal || 0
      ),
      Number(body.tax || 0),
      Number(body.total || 0),
      body.status ||
        "Ordered",
      body.paymentMethod ||
        "Cash",
      body.notes || null,
      user.id,
      now,
      now
    )
    .run();

  await audit(
    env,
    user,
    "purchase_created",
    businessId,
    body.branchId ||
      user.branchId ||
      null,
    {
      purchaseId: id
    },
    request
  );

  return {
    success: true,
    purchase:
      await env.DB.prepare(
        `
        SELECT *
        FROM purchases
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   CUSTOMERS
   ================================================================ */

async function getCustomers(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      customers: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const { results } =
    await env.DB.prepare(
      `
      SELECT *
      FROM customers
      WHERE business_id = ?
      ORDER BY created_at DESC
      `
    )
      .bind(businessId)
      .all();

  return {
    success: true,
    customers: results
  };
}

async function createCustomer(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "cashier",
    "sales_staff",
    "waiter"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  if (!body.name) {
    return jsonError(
      "Customer name is required",
      400
    );
  }

  const id =
    generateId("customer");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO customers
    (
      id,
      business_id,
      name,
      phone,
      email,
      address,
      total_purchases,
      balance,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      businessId,
      body.name,
      body.phone || null,
      body.email || null,
      body.address || null,
      Number(
        body.totalPurchases || 0
      ),
      Number(
        body.balance || 0
      ),
      body.status || "Active",
      now,
      now
    )
    .run();

  return {
    success: true,
    customer:
      await env.DB.prepare(
        `
        SELECT *
        FROM customers
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

async function updateCustomer(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "cashier",
    "sales_staff",
    "waiter"
  ]);

  const customer =
    await env.DB.prepare(
      `
      SELECT *
      FROM customers
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!customer) {
    return jsonError(
      "Customer not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    customer.business_id
  );

  const body =
    await request.json();

  await env.DB.prepare(
    `
    UPDATE customers
    SET
      name = ?,
      phone = ?,
      email = ?,
      address = ?,
      total_purchases = ?,
      balance = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      body.name ?? customer.name,
      body.phone ?? customer.phone,
      body.email ?? customer.email,
      body.address ?? customer.address,
      Number(
        body.totalPurchases ??
          customer.total_purchases
      ),
      Number(
        body.balance ??
          customer.balance
      ),
      body.status ?? customer.status,
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "customer_updated",
    customer.business_id,
    null,
    {
      customerId: id
    },
    request
  );

  return {
    success: true,
    customer:
      await env.DB.prepare(
        `
        SELECT *
        FROM customers
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   SUPPLIERS
   ================================================================ */

async function getSuppliers(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      suppliers: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const { results } =
    await env.DB.prepare(
      `
      SELECT *
      FROM suppliers
      WHERE business_id = ?
      ORDER BY created_at DESC
      `
    )
      .bind(businessId)
      .all();

  return {
    success: true,
    suppliers: results
  };
}

async function createSupplier(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "inventory_manager",
    "accountant"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const id =
    generateId("supplier");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO suppliers
    (
      id,
      business_id,
      name,
      contact_person,
      phone,
      email,
      address,
      total_purchases,
      outstanding,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      businessId,
      body.name,
      body.contactPerson ||
        null,
      body.phone || null,
      body.email || null,
      body.address || null,
      Number(
        body.totalPurchases || 0
      ),
      Number(
        body.outstanding || 0
      ),
      body.status || "Active",
      now,
      now
    )
    .run();

  return {
    success: true,
    supplier:
      await env.DB.prepare(
        `
        SELECT *
        FROM suppliers
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

async function updateSupplier(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "inventory_manager",
    "accountant"
  ]);

  const supplier =
    await env.DB.prepare(
      `
      SELECT *
      FROM suppliers
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!supplier) {
    return jsonError(
      "Supplier not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    supplier.business_id
  );

  const body =
    await request.json();

  await env.DB.prepare(
    `
    UPDATE suppliers
    SET
      name = ?,
      contact_person = ?,
      phone = ?,
      email = ?,
      address = ?,
      total_purchases = ?,
      outstanding = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      body.name ?? supplier.name,
      body.contactPerson ??
        supplier.contact_person,
      body.phone ?? supplier.phone,
      body.email ?? supplier.email,
      body.address ?? supplier.address,
      Number(
        body.totalPurchases ??
          supplier.total_purchases
      ),
      Number(
        body.outstanding ??
          supplier.outstanding
      ),
      body.status ?? supplier.status,
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "supplier_updated",
    supplier.business_id,
    null,
    {
      supplierId: id
    },
    request
  );

  return {
    success: true,
    supplier:
      await env.DB.prepare(
        `
        SELECT *
        FROM suppliers
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   EXPENSES
   ================================================================ */

async function getExpenses(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      expenses: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  let sql = `
    SELECT *
    FROM expenses
    WHERE business_id = ?
  `;

  const params = [
    businessId
  ];

  const branchId =
    query.get("branchId");

  if (branchId) {
    sql +=
      " AND branch_id = ?";
    params.push(branchId);
  }

  sql +=
    " ORDER BY date DESC";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    expenses: results
  };
}

async function createExpense(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "accountant"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  if (!body.category) {
    return jsonError(
      "Expense category is required",
      400
    );
  }

  const id =
    generateId("expense");

  const now =
    new Date().toISOString();

  await env.DB.prepare(
    `
    INSERT INTO expenses
    (
      id,
      business_id,
      branch_id,
      category,
      description,
      amount,
      date,
      recorded_by,
      payment_method,
      receipt,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      id,
      businessId,
      body.branchId ||
        user.branchId ||
        null,
      body.category,
      body.description || null,
      Number(body.amount || 0),
      body.date ||
        now.slice(0, 10),
      user.id,
      body.paymentMethod ||
        "Cash",
      body.receipt || null,
      now,
      now
    )
    .run();

  await audit(
    env,
    user,
    "expense_created",
    businessId,
    body.branchId ||
      user.branchId ||
      null,
    {
      expenseId: id,
      amount: body.amount
    },
    request
  );

  return {
    success: true,
    expense:
      await env.DB.prepare(
        `
        SELECT *
        FROM expenses
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

async function updateExpense(
  request,
  env,
  id
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin",
    "store_manager",
    "accountant"
  ]);

  const expense =
    await env.DB.prepare(
      `
      SELECT *
      FROM expenses
      WHERE id = ?
      `
    )
      .bind(id)
      .first();

  if (!expense) {
    return jsonError(
      "Expense not found",
      404
    );
  }

  requireBusinessAccess(
    user,
    expense.business_id
  );

  const body =
    await request.json();

  const branchId =
    body.branchId !== undefined
      ? body.branchId
      : expense.branch_id;

  await env.DB.prepare(
    `
    UPDATE expenses
    SET
      branch_id = ?,
      category = ?,
      description = ?,
      amount = ?,
      date = ?,
      payment_method = ?,
      receipt = ?,
      updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      branchId || null,
      body.category ?? expense.category,
      body.description ?? expense.description,
      Number(
        body.amount ?? expense.amount
      ),
      body.date ?? expense.date,
      body.paymentMethod ??
        expense.payment_method,
      body.receipt !== undefined
        ? body.receipt
        : expense.receipt,
      new Date().toISOString(),
      id
    )
    .run();

  await audit(
    env,
    user,
    "expense_updated",
    expense.business_id,
    branchId || null,
    {
      expenseId: id
    },
    request
  );

  return {
    success: true,
    expense:
      await env.DB.prepare(
        `
        SELECT *
        FROM expenses
        WHERE id = ?
        `
      )
        .bind(id)
        .first()
  };
}

/* ================================================================
   SETTINGS
   ================================================================ */

async function getSettings(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  let settings =
    await env.DB.prepare(
      `
      SELECT *
      FROM settings
      WHERE business_id = ?
      `
    )
      .bind(businessId)
      .first();

  if (!settings) {
    await env.DB.prepare(
      `
      INSERT INTO settings
      (
        business_id
      )
      VALUES (?)
      `
    )
      .bind(businessId)
      .run();

    settings =
      await env.DB.prepare(
        `
        SELECT *
        FROM settings
        WHERE business_id = ?
        `
      )
        .bind(businessId)
        .first();
  }

  return {
    success: true,
    settings
  };
}

async function updateSettings(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  requireRole(user, [
    "owner",
    "admin"
  ]);

  const body =
    await request.json();

  const businessId =
    user.role === "owner"
      ? body.businessId
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  await env.DB.prepare(
    `
    INSERT INTO settings
    (
      business_id,
      receipt_format,
      receipt_footer,
      receipt_prefix,
      receipt_numbering,
      receipt_padding,
      default_payment,
      refund_password,
      enable_tax,
      tax_rate,
      enable_discounts,
      payment_methods,
      date_format,
      language,
      enable_email_notifications,
      enable_audit,
      receipt_paperless,
      barcode_scanner,
      customer_display,
      staff_reports,
      staff_refunds,
      low_stock_alerts,
      multi_branch,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(business_id)
    DO UPDATE SET
      receipt_format =
        excluded.receipt_format,
      receipt_footer =
        excluded.receipt_footer,
      receipt_prefix =
        excluded.receipt_prefix,
      receipt_numbering =
        excluded.receipt_numbering,
      receipt_padding =
        excluded.receipt_padding,
      default_payment =
        excluded.default_payment,
      refund_password =
        excluded.refund_password,
      enable_tax =
        excluded.enable_tax,
      tax_rate =
        COALESCE(
          excluded.tax_rate,
          tax_rate
        ),
      enable_discounts =
        excluded.enable_discounts,
      payment_methods =
        excluded.payment_methods,
      date_format =
        excluded.date_format,
      language =
        excluded.language,
      enable_email_notifications =
        excluded.enable_email_notifications,
      enable_audit =
        excluded.enable_audit,
      receipt_paperless =
        excluded.receipt_paperless,
      barcode_scanner =
        excluded.barcode_scanner,
      customer_display =
        excluded.customer_display,
      staff_reports =
        excluded.staff_reports,
      staff_refunds =
        excluded.staff_refunds,
      low_stock_alerts =
        excluded.low_stock_alerts,
      multi_branch =
        excluded.multi_branch,
      updated_at =
        excluded.updated_at
    `
  )
    .bind(
      businessId,
      body.receiptFormat ||
        "Standard 80mm",
      body.receiptFooter ||
        "Thank you for shopping with us!",
      body.receiptPrefix ||
        "RF",
      body.receiptNumbering ||
        "date-random",
      typeof body.receiptPadding === "number" &&
      Number.isFinite(body.receiptPadding)
        ? body.receiptPadding
        : 6,
      body.defaultPayment ||
        "Cash",
      body.refundPassword ||
        "",
      body.enableTax !== false
        ? 1
        : 0,
      typeof body.taxRate === "number" &&
      Number.isFinite(body.taxRate)
        ? body.taxRate
        : null,
      body.enableDiscounts !== false
        ? 1
        : 0,
      JSON.stringify(
        body.paymentMethods ||
          [
            "Cash",
            "M-Pesa",
            "Card"
          ]
      ),
      body.dateFormat ||
        "DD/MM/YYYY",
      body.language ||
        "English",
      body.enableEmailNotifications !==
      false
        ? 1
        : 0,
      body.enableAudit !== false
        ? 1
        : 0,
      body.receiptPaperless !== false
        ? 1
        : 0,
      body.barcodeScanner !== false
        ? 1
        : 0,
      body.customerDisplay !== false
        ? 1
        : 0,
      body.staffReports !== false
        ? 1
        : 0,
      body.staffRefunds !== false
        ? 1
        : 0,
      body.lowStockAlerts !== false
        ? 1
        : 0,
      body.multiBranch !== false
        ? 1
        : 0,
      new Date().toISOString()
    )
    .run();

  await audit(
    env,
    user,
    "settings_updated",
    businessId,
    null,
    null,
    request
  );

  return {
    success: true
  };
}

/* ================================================================
   AUDIT LOGS
   ================================================================ */

async function getAuditLogs(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  let sql = `
    SELECT
      a.*,
      u.name AS user_name,
      u.email AS user_email
    FROM audit_logs a
    LEFT JOIN users u
      ON a.user_id = u.id
    WHERE 1 = 1
  `;

  const params = [];

  if (businessId) {
    requireBusinessAccess(
      user,
      businessId
    );

    sql +=
      " AND a.business_id = ?";
    params.push(businessId);
  } else if (
    user.role !== "owner"
  ) {
    sql +=
      " AND a.business_id = ?";
    params.push(user.businessId);
  }

  const branchId =
    query.get("branchId");

  if (branchId) {
    sql +=
      " AND a.branch_id = ?";
    params.push(branchId);
  }

  sql +=
    " ORDER BY a.date DESC LIMIT 500";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    logs: results
  };
}

/* ================================================================
   DASHBOARD
   ================================================================ */

async function getDashboard(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  /*
   * PLATFORM OWNER
   */

  if (user.role === "owner") {
    const businessCount =
      await env.DB.prepare(
        `
        SELECT COUNT(*) AS count
        FROM businesses
        `
      ).first();

    const activeBusinesses =
      await env.DB.prepare(
        `
        SELECT COUNT(*) AS count
        FROM businesses
        WHERE status = 'Active'
        `
      ).first();

    const branchCount =
      await env.DB.prepare(
        `
        SELECT COUNT(*) AS count
        FROM branches
        `
      ).first();

    const staffCount =
      await env.DB.prepare(
        `
        SELECT COUNT(*) AS count
        FROM users
        WHERE role != 'owner'
        `
      ).first();

    const sales =
      await env.DB.prepare(
        `
        SELECT
          COALESCE(
            SUM(total),
            0
          ) AS total,
          COUNT(*) AS transactions
        FROM sales
        WHERE date(date) = ?
        AND status = 'Completed'
        `
      )
        .bind(today)
        .first();

    const products =
      await env.DB.prepare(
        `
        SELECT COUNT(*) AS count
        FROM products
        `
      ).first();

    return {
      success: true,
      dashboard: {
        businesses:
          businessCount.count || 0,
        activeBusinesses:
          activeBusinesses.count || 0,
        branches:
          branchCount.count || 0,
        staff:
          staffCount.count || 0,
        products:
          products.count || 0,
        todaySales:
          Number(
            sales.total || 0
          ),
        todayTransactions:
          sales.transactions || 0
      }
    };
  }

  /*
   * BUSINESS ADMIN / MANAGER
   */

  const businessId =
    user.businessId;

  if (!businessId) {
    throw new AuthError(
      "Business not assigned",
      403
    );
  }

  const branchId =
    getBranchId(
      user,
      query.get("branchId")
    );

  let salesSql = `
    SELECT
      COALESCE(
        SUM(total),
        0
      ) AS total,
      COUNT(*) AS transactions
    FROM sales
    WHERE business_id = ?
    AND date(date) = ?
    AND status = 'Completed'
  `;

  const salesParams = [
    businessId,
    today
  ];

  if (branchId) {
    salesSql +=
      " AND branch_id = ?";
    salesParams.push(branchId);
  }

  const sales =
    await env.DB.prepare(
      salesSql
    )
      .bind(...salesParams)
      .first();

  let productSql = `
    SELECT COUNT(*) AS count
    FROM products
    WHERE business_id = ?
  `;

  const productParams = [
    businessId
  ];

  if (branchId) {
    productSql += `
      AND (
        branch_id = ?
        OR branch_id IS NULL
      )
    `;

    productParams.push(
      branchId
    );
  }

  const products =
    await env.DB.prepare(
      productSql
    )
      .bind(...productParams)
      .first();

  const staff =
    await env.DB.prepare(
      `
      SELECT COUNT(*) AS count
      FROM users
      WHERE business_id = ?
      AND role != 'owner'
      `
    )
      .bind(businessId)
      .first();

  const branches =
    await env.DB.prepare(
      `
      SELECT COUNT(*) AS count
      FROM branches
      WHERE business_id = ?
      `
    )
      .bind(businessId)
      .first();

  const lowStock =
    await env.DB.prepare(
      `
      SELECT COUNT(*) AS count
      FROM products
      WHERE business_id = ?
      AND stock <= reorder_level
      `
    )
      .bind(businessId)
      .first();

  return {
    success: true,
    dashboard: {
      todaySales:
        Number(
          sales.total || 0
        ),
      todayTransactions:
        sales.transactions || 0,
      products:
        products.count || 0,
      staff:
        staff.count || 0,
      branches:
        branches.count || 0,
      lowStock:
        lowStock.count || 0
    }
  };
}

/* ================================================================
   STOCK MOVEMENTS
   ================================================================ */

async function getStockMovements(
  request,
  env,
  query
) {
  const user = await requireUser(
    request,
    env
  );

  let businessId =
    query.get("businessId");

  if (user.role !== "owner") {
    businessId =
      user.businessId;
  }

  if (!businessId) {
    return {
      success: true,
      movements: []
    };
  }

  requireBusinessAccess(
    user,
    businessId
  );

  let sql = `
    SELECT
      sm.*,
      p.name AS product_name,
      u.name AS user_name
    FROM stock_movements sm
    LEFT JOIN products p
      ON sm.product_id = p.id
    LEFT JOIN users u
      ON sm.created_by = u.id
    WHERE sm.business_id = ?
  `;

  const params = [
    businessId
  ];

  const productId =
    query.get("productId");

  if (productId) {
    sql +=
      " AND sm.product_id = ?";
    params.push(productId);
  }

  const branchId =
    query.get("branchId");

  if (branchId) {
    sql +=
      " AND sm.branch_id = ?";
    params.push(branchId);
  }

  sql +=
    " ORDER BY sm.date DESC LIMIT 500";

  const { results } =
    await env.DB.prepare(sql)
      .bind(...params)
      .all();

  return {
    success: true,
    movements: results
  };
}

/* ================================================================
   FILES — R2 object storage
   ----------------------------------------------------------------
   Product images (and later receipts / documents) are stored in a
   Cloudflare R2 bucket bound to `env.BUCKET` (see wrangler.toml).
   Each upload is recorded in the `cloud_files` D1 table and the
   object is served back through `GET /files/<object_key>`.
   ================================================================ */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;      // 5 MB
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml"
]);
const CACHE_IMAGE_HEADERS =
  "public, max-age=31536000, immutable";

function fileExtension(contentType) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg"
  };
  return map[contentType] || "bin";
}

/* POST /upload — stores one image under products/<businessId>/.
   Expects multipart/form-data with fields:
     file        (the image File)
     businessId  (required for owners; ignored for scoped roles) */
async function uploadImage(
  request,
  env
) {
  const user = await requireUser(
    request,
    env
  );

  const form =
    await request.formData();

  const file =
    form.get("file");

  if (!file || typeof file === "string") {
    return jsonError(
      "No file provided (multipart field 'file')",
      400
    );
  }

  const businessId =
    user.role === "owner"
      ? String(form.get("businessId") || "").trim() || null
      : user.businessId;

  if (!businessId) {
    return jsonError(
      "Business ID is required",
      400
    );
  }

  requireBusinessAccess(
    user,
    businessId
  );

  const contentType =
    String(file.type || "")
      .toLowerCase();

  if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
    return jsonError(
      "Unsupported file type — upload a JPG, PNG, WebP, GIF, AVIF or SVG image",
      400
    );
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(
      "Image is too large — maximum size is 5 MB",
      400
    );
  }

  if (!env.BUCKET) {
    return jsonError(
      "Uploads are not configured — add the R2 'BUCKET' binding in wrangler.toml",
      500
    );
  }

  const key =
    `products/${businessId}/${generateId("img")}.${fileExtension(contentType)}`;

  await env.BUCKET.put(
    key,
    file.stream(),
    {
      httpMetadata: {
        contentType,
        cacheControl: CACHE_IMAGE_HEADERS
      }
    }
  );

  await env.DB.prepare(
    `
    INSERT INTO cloud_files
    (
      id,
      business_id,
      branch_id,
      object_key,
      filename,
      content_type,
      size_bytes,
      uploaded_by,
      uploaded_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      generateId("file"),
      businessId,
      null,
      key,
      file.name || key,
      contentType,
      file.size,
      user.id || null,
      new Date().toISOString()
    )
    .run();

  await audit(
    env,
    user,
    "file_uploaded",
    businessId,
    null,
    { objectKey: key, contentType, sizeBytes: file.size },
    request
  );

  const url =
    `${new URL(request.url).origin}/files/${key}`;

  return {
    success: true,
    url,
    key,
    name: file.name || key,
    contentType,
    sizeBytes: file.size
  };
}

/* GET /files/<object_key> — serves the object from R2. */
async function serveStoredFile(
  request,
  env,
  key
) {
  if (!env.BUCKET) {
    return jsonError(
      "Uploads are not configured",
      500
    );
  }

  const object =
    await env.BUCKET.get(key);

  if (!object) {
    return new Response(
      "File not found",
      { status: 404 }
    );
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", CACHE_IMAGE_HEADERS);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-RetailFlow-Object", key);

  return new Response(
    object.body,
    { headers }
  );
}

/* ================================================================
   M-PESA DARAJA INTEGRATION
   ----------------------------------------------------------------
   Multi-tenant M-Pesa STK Push payments. Every operation derives the
   authenticated business from Firebase → D1 (never trusts a client
   businessId). Credentials are stored AES-256-GCM encrypted in D1
   and never returned to the browser. Uniqueness controls
   (checkout_request_id / mpesa_receipt_number) prevent duplicate
   sale creation from duplicate callbacks.
   ================================================================ */

const MPESA_CONFIG_ROLES = ["owner", "admin"];
const MPESA_SALE_ROLES = [
  "owner",
  "admin",
  "store_manager",
  "cashier",
  "sales_staff",
  "waiter"
];
const MPESA_VIEW_ROLES = ["owner", "admin", "store_manager"];
const RETAILFLOW_CALLBACK_URL =
  "https://retailflow-api.princealexdigital.workers.dev/api/mpesa/callback";

/**
 * Guard: verify the D1 binding is present before touching the
 * database. Returns a friendly jsonError Response when missing.
 * Pass `request` so we can also surface auth-free details.
 */
function assertDbBinding(env) {
  if (!env || !env.DB) {
    throw new AuthError(
      "Database is not configured — add the D1 binding named 'DB' to this Worker (wrangler.toml [[d1_databases]] or dashboard → Settings → D1).",
      500
    );
  }
  return true;
}

/*
 * Amount reconciliation rule (see spec §28).
 * M-Pesa only handles whole shillings, so a cent-level difference
 * between the requested amount and the paid amount is normal.
 *   paid == expected                 → complete, change 0
 *   0 < expected - paid <= 1 KES     → complete, change 0 (rounding)
 *   paid > expected                  → complete, change = paid - expected
 *   expected - paid > 1 KES          → Underpaid, sale stays Pending
 *                                    → manager resolves (complete/void)
 */
const MPESA_AMOUNT_TOLERANCE_KES = 1;

function mpesaEnabledValue(val) {
  return Number(val) === 1;
}

/** Build the safe metadata object clients may see (never secrets). */
function safeMpesaMeta(row) {
  if (!row) {
    return {
      configured: false,
      enabled: false,
      environment: "sandbox",
      shortcode: "",
      shortcodeType: "Till",
      accountReference: "",
      passkeyConfigured: false,
      connectionStatus: "Not Configured",
      lastConnectionTest: null,
      callbackUrl: RETAILFLOW_CALLBACK_URL
    };
  }
  return {
    configured: true,
    enabled: mpesaEnabledValue(row.enabled),
    environment: row.environment || "sandbox",
    shortcode: row.shortcode || "",
    shortcodeType: row.shortcode_type || "Till",
    accountReference: row.account_reference || "",
    passkeyConfigured: !!row.passkey_encrypted,
    connectionStatus: row.connection_status || "Not Tested",
    lastConnectionTest: row.last_connection_test || null,
    callbackUrl: row.callback_url || RETAILFLOW_CALLBACK_URL
  };
}

async function loadMpesaConfig(env, businessId) {
  return env.DB.prepare(
    `
    SELECT *
    FROM mpesa_configurations
    WHERE business_id = ?
    LIMIT 1
    `
  )
    .bind(businessId)
    .first();
}

/** Decrypt the three Daraja secrets inside the Worker only. */
async function decryptMpesaSecrets(env, cfg) {
  return {
    consumerKey: await decryptSecret(
      cfg.consumer_key_encrypted,
      env
    ),
    consumerSecret: await decryptSecret(
      cfg.consumer_secret_encrypted,
      env
    ),
    passkey: await decryptSecret(
      cfg.passkey_encrypted,
      env
    )
  };
}

/* ------------------------------------------------------------------
   GET /mpesa/config
   Safe configuration metadata for any business member who needs to
   know whether M-Pesa is available at the POS.
   ------------------------------------------------------------------ */
async function getMpesaConfig(request, env, query) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  const businessId = getBusinessId(
    user,
    query.get("businessId")
  );

  if (!businessId) {
    return { success: true, mpesa: safeMpesaMeta(null) };
  }

  requireBusinessAccess(user, businessId);

  try {
    const row = await loadMpesaConfig(env, businessId);
    return { success: true, mpesa: safeMpesaMeta(row) };
  } catch (error) {
    // Tolerate a missing table (migration 002 not applied yet) so the
    // admin console can still render instead of hard-failing.
    const msg = String((error && error.message) || "").toLowerCase();
    if (msg.indexOf("no such table") !== -1) {
      return { success: true, mpesa: safeMpesaMeta(null) };
    }
    throw error;
  }
}
/* ------------------------------------------------------------------
   PUT /mpesa/config
   Owner / Business Admin only. Encrypts credentials and stores them
   per-business. If credential fields are present they are treated as
   replacements and the connection status resets to "Not Tested".
   If they are absent the existing encrypted credentials are kept
   (used for toggling enabled / changing metadata).
   ------------------------------------------------------------------ */
async function updateMpesaConfig(request, env) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  requireRole(user, MPESA_CONFIG_ROLES);

  const body = await request.json().catch(() => ({}));

  const businessId =
    user.role === "owner"
      ? String(body.businessId || "").trim()
      : user.businessId;

  if (!businessId) {
    return jsonError("Business ID is required", 400);
  }

  requireBusinessAccess(user, businessId);

  const business = await env.DB.prepare(
    `
    SELECT id
    FROM businesses
    WHERE id = ?
    LIMIT 1
    `
  )
    .bind(businessId)
    .first();

  if (!business) {
    return jsonError("Business not found", 404);
  }

  const environment = ["sandbox", "production"].includes(
    body.environment
  )
    ? body.environment
    : "sandbox";

  const shortcodeType = ["Till", "PayBill"].includes(
    body.shortcodeType
  )
    ? body.shortcodeType
    : "Till";

  const shortcode = String(body.shortcode || "")
    .trim()
    .replace(/\D/g, "");

  if (!shortcode || shortcode.length < 4) {
    return jsonError("Enter a valid M-Pesa PayBill or Till number", 400);
  }

  const accountReference = String(
    body.accountReference || body.account_reference || "RetailFlow"
  )
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12);
  const transactionDesc = String(
    body.transactionDesc || body.transaction_description || "Payment"
  )
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .slice(0, 13);

  const now = new Date().toISOString();

  let existing;
  let hasCredentialFields;
  let consumerKeyEncrypted;
  let consumerSecretEncrypted;
  let passkeyEncrypted;
  let credentialsReplaced = false;
  let updated;

  try {
    existing = await loadMpesaConfig(env, businessId);

    hasCredentialFields =
      body.consumerKey != null ||
      body.consumerSecret != null;

    /*
     * The Passkey is OPTIONAL (sandbox apps often show "Passkey: N/A").
     * It is only needed for STK Push — Test Connection (OAuth) works
     * with just the Consumer Key + Secret. When blank we keep the
     * stored passkey, or store an encrypted empty string so the NOT
     * NULL column always holds a valid v1 envelope ("not configured").
     */
    consumerKeyEncrypted = existing
      ? existing.consumer_key_encrypted
      : "";
    consumerSecretEncrypted = existing
      ? existing.consumer_secret_encrypted
      : "";
    passkeyEncrypted = existing
      ? existing.passkey_encrypted
      : "";

    if (hasCredentialFields) {
      if (!body.consumerKey || !body.consumerSecret) {
        return jsonError(
          "Consumer Key and Consumer Secret are required",
          400
        );
      }

      consumerKeyEncrypted = await encryptSecret(body.consumerKey, env);
      consumerSecretEncrypted = await encryptSecret(body.consumerSecret, env);

      if (body.passkey) {
        passkeyEncrypted = await encryptSecret(body.passkey, env);
      }
      credentialsReplaced = true;
    }

    if (!existing && !hasCredentialFields) {
      return jsonError(
        "Consumer Key and Consumer Secret are required",
        400
      );
    }

    // Guarantee a valid envelope for the NOT NULL passkey column.
    if (!passkeyEncrypted) {
      passkeyEncrypted = await encryptSecret("", env);
    }

    if (!existing) {
      await env.DB.prepare(
        `
        INSERT INTO mpesa_configurations
        (
          id,
          business_id,
          enabled,
          environment,
          shortcode,
          shortcode_type,
          consumer_key_encrypted,
          consumer_secret_encrypted,
          passkey_encrypted,
          callback_url,
          account_reference,
          transaction_desc,
          connection_status,
          last_connection_test,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
        .bind(
          generateId("mpesacfg"),
          businessId,
          body.enabled ? 1 : 0,
          environment,
          shortcode,
          shortcodeType,
          consumerKeyEncrypted,
          consumerSecretEncrypted,
          passkeyEncrypted,
          RETAILFLOW_CALLBACK_URL,
          accountReference,
          transactionDesc,
          "Not Tested",
          null,
          now,
          now
        )
        .run();

      await audit(
        env,
        user,
        "mpesa_config_created",
        businessId,
        null,
        { environment, shortcode, shortcodeType, enabled: !!body.enabled },
        request
      );
    } else {
      const enabledChanged =
        mpesaEnabledValue(existing.enabled) !== !!body.enabled;

      await env.DB.prepare(
        `
        UPDATE mpesa_configurations
        SET
          enabled = ?,
          environment = ?,
          shortcode = ?,
          shortcode_type = ?,
          consumer_key_encrypted = ?,
          consumer_secret_encrypted = ?,
          passkey_encrypted = ?,
          account_reference = ?,
          transaction_desc = ?,
          connection_status = ?,
          updated_at = ?
        WHERE id = ?
        `
      )
        .bind(
          body.enabled ? 1 : 0,
          environment,
          shortcode,
          shortcodeType,
          consumerKeyEncrypted,
          consumerSecretEncrypted,
          passkeyEncrypted,
          accountReference,
          transactionDesc,
          credentialsReplaced
            ? "Not Tested"
            : existing.connection_status || "Not Tested",
          now,
          existing.id
        )
        .run();

      if (credentialsReplaced) {
        await audit(
          env,
          user,
          "mpesa_config_updated",
          businessId,
          null,
          { environment, shortcode, shortcodeType, credentialsReplaced: true },
          request
        );
      }
      if (enabledChanged) {
        await audit(
          env,
          user,
          body.enabled ? "mpesa_enabled" : "mpesa_disabled",
          businessId,
          null,
          { shortcode },
          request
        );
      }
    }

    updated = await loadMpesaConfig(env, businessId);
  } catch (error) {
    console.error("M-Pesa config save failed:", error);
    const msg = String((error && error.message) || "");
    if (msg.toLowerCase().indexOf("no such table") !== -1) {
      return jsonError(
        "M-Pesa is not set up yet. Please run the database migration (002_mpesa_daraja.sql) before configuring M-Pesa.",
        500
      );
    }
    if (msg.indexOf("RETAILFLOW_ENCRYPTION_KEY") !== -1) {
      // Surface the actionable encryption-key message directly.
      return jsonError(msg, 500);
    }
    return jsonError(
      "Unable to save M-Pesa configuration. Please try again.",
      500
    );
  }

  return {
    success: true,
    mpesa: safeMpesaMeta(updated),
    message: "M-Pesa configuration saved securely."
  };
}

/* ------------------------------------------------------------------
   POST /mpesa/test
   Owner / Business Admin only. Decrypts the saved credentials in the
   Worker, requests a Daraja OAuth token (which fails if the
   credentials are wrong) and records the outcome. Never returns
   secrets or tokens — even in error responses.
   ------------------------------------------------------------------ */
async function testMpesaConnection(request, env) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  requireRole(user, MPESA_CONFIG_ROLES);

  const body = await request.json().catch(() => ({}));

  const businessId =
    user.role === "owner"
      ? String(body.businessId || "").trim()
      : user.businessId;

  if (!businessId) {
    return jsonError("Business ID is required", 400);
  }

  requireBusinessAccess(user, businessId);

  const cfg = await loadMpesaConfig(env, businessId);

  if (!cfg) {
    return jsonError("M-Pesa is not configured for this business.", 400);
  }

  let secrets;
  try {
    secrets = await decryptMpesaSecrets(env, cfg);
  } catch (error) {
    return jsonError(
      "M-Pesa credentials could not be decrypted on the server.",
      500
    );
  }

  const now = new Date().toISOString();

  try {
    await getOAuthToken(env, {
      environment: cfg.environment || "sandbox",
      consumerKey: secrets.consumerKey,
      consumerSecret: secrets.consumerSecret
    });
  } catch (error) {
    if (error instanceof DarajaError) {
      await env.DB.prepare(
        `
        UPDATE mpesa_configurations
        SET connection_status = ?,
            last_connection_test = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
        .bind("Connection Failed", now, now, cfg.id)
        .run();

      await audit(
        env,
        user,
        "mpesa_connection_tested",
        businessId,
        null,
        { success: false, environment: cfg.environment },
        request
      );

      return jsonError(
        "M-Pesa connection failed. Please check your Daraja credentials.",
        502
      );
    }
    throw error;
  }

  await env.DB.prepare(
    `
    UPDATE mpesa_configurations
    SET connection_status = ?,
        last_connection_test = ?,
        updated_at = ?
    WHERE id = ?
    `
  )
    .bind("Connected", now, now, cfg.id)
    .run();

  await audit(
    env,
    user,
    "mpesa_connection_tested",
    businessId,
    null,
    { success: true, environment: cfg.environment },
    request
  );

  return {
    success: true,
    status: "Connected",
    message: "M-Pesa connection successful."
  };
}

/* ------------------------------------------------------------------
   Authoritative sale computation for M-Pesa payments.
   The POS cart is re-resolved from D1 (prices, taxes, stock) exactly
   like POST /sales. Returns { ok: true, value } or
   { ok: false, response }. The client-supplied amount must match
   this computed total — this stops tampering with the paid amount.
   ------------------------------------------------------------------ */
async function authoritativeSaleComputation(
  env,
  body,
  businessId,
  branchId,
  user
) {
  const items = Array.isArray(body.items) ? body.items : [];

  if (!items.length) {
    return {
      ok: false,
      response: jsonError("Sale must contain at least one item", 400)
    };
  }

  let settings = await env.DB.prepare(
    `
    SELECT *
    FROM settings
    WHERE business_id = ?
    `
  )
    .bind(businessId)
    .first();

  if (!settings) {
    await env.DB.prepare(
      `
      INSERT INTO settings (business_id)
      VALUES (?)
      `
    )
      .bind(businessId)
      .run();
    settings = await env.DB.prepare(
      `
      SELECT *
      FROM settings
      WHERE business_id = ?
      `
    )
      .bind(businessId)
      .first();
  }

  const taxEnabled = Number(settings && settings.enable_tax) === 1;
  const taxRatePct =
    taxEnabled && settings.tax_rate != null
      ? Number(settings.tax_rate)
      : 0;
  const discountsEnabled = !(
    settings && Number(settings.enable_discounts) === 0
  );
  const canDiscount =
    discountsEnabled &&
    ["owner", "admin", "store_manager"].includes(user.role);

  const customerId = body.customerId || null;

  if (customerId) {
    const customer = await env.DB.prepare(
      `
      SELECT id
      FROM customers
      WHERE id = ? AND business_id = ?
      `
    )
      .bind(customerId, businessId)
      .first();
    if (!customer) {
      return { ok: false, response: jsonError("Customer not found", 404) };
    }
  }

  const resolved = [];
  let subtotal = 0;
  let taxTotal = 0;

  for (const item of items) {
    if (!item.productId) continue;

    const qty = Math.floor(Number(item.quantity || 0));
    if (qty <= 0) {
      return {
        ok: false,
        response: jsonError("Invalid product quantity", 400)
      };
    }

    const product = await env.DB.prepare(
      `
      SELECT *
      FROM products
      WHERE id = ? AND business_id = ?
      `
    )
      .bind(item.productId, businessId)
      .first();

    if (!product) {
      return {
        ok: false,
        response: jsonError(
          `Product not found: ${item.name || item.productId}`,
          404
        )
      };
    }

    if (product.branch_id && branchId && product.branch_id !== branchId) {
      return {
        ok: false,
        response: jsonError(
          `Product not available at this branch: ${product.name}`,
          403
        )
      };
    }

    if (String(product.status || "Active").toLowerCase() !== "active") {
      return {
        ok: false,
        response: jsonError(
          `Product is not available for sale: ${product.name}`,
          409
        )
      };
    }

    if (Number(product.stock) < qty) {
      return {
        ok: false,
        response: jsonError(`Insufficient stock for ${product.name}`, 400)
      };
    }

                const sellingPrice = Number(product.selling_price || 0);
    const offerPrice = Number(product.offer_price || 0);
    const hasOffer = (offerPrice > 0 && offerPrice < sellingPrice);
    const unitPrice = hasOffer ? offerPrice : sellingPrice;
    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    const lineTax =
      product.tax && taxRatePct > 0
        ? Math.round(lineTotal * taxRatePct * 100) / ((100 + taxRatePct) * 100)
        : 0;

    subtotal += lineTotal;
    taxTotal += lineTax;

    resolved.push({
      productId: product.id,
      name: product.name,
      sku: product.sku || null,
      quantity: qty,
      price: unitPrice,
      total: lineTotal,
      hasOffer: hasOffer,
      savings: hasOffer ? Math.round((sellingPrice - offerPrice) * 100) / 100 : 0
    });
  }

  if (!resolved.length) {
    return {
      ok: false,
      response: jsonError("Sale must contain at least one valid item", 400)
    };
  }

  subtotal = Math.round(subtotal * 100) / 100;
  taxTotal = Math.round(taxTotal * 100) / 100;

  let discount = 0;
  if (canDiscount && body.discount != null) {
    const raw = Number(body.discount);
    if (!Number.isFinite(raw) || raw < 0) {
      return { ok: false, response: jsonError("Invalid discount", 400) };
    }
    discount =
      body.discountType === "percent"
        ? Math.round(subtotal * Math.min(raw, 100)) / 100
        : Math.min(Math.round(raw * 100) / 100, subtotal);
  }

  if (discount > subtotal) discount = subtotal;

  const total = Math.round((subtotal - discount) * 100) / 100;
  const receiptNumber =
    String(body.receiptNumber || "")
      .slice(0, 50) ||
    `RF-${Date.now()}`;

  return {
    ok: true,
    value: {
      resolved,
      subtotal,
      tax: taxTotal,
      discount,
      total,
      customerId,
      receiptNumber
    }
  };
}

/* ------------------------------------------------------------------
   POST /mpesa/stkpush
   Initiates an M-Pesa STK Push prompt. Creates the sale as
   "Pending" — the sale is only completed (stock deducted, receipt
   ready) when the Daraja callback confirms the payment. businessId /
   branchId come from the authenticated user, never the client.
   ------------------------------------------------------------------ */
async function initiateStkPush(request, env) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  requireRole(user, MPESA_SALE_ROLES);

  const body = await request.json().catch(() => ({}));

  const businessId =
    user.role === "owner"
      ? String(body.businessId || "").trim() || null
      : user.businessId;

  if (!businessId) {
    return jsonError("Business ID is required", 400);
  }

  requireBusinessAccess(user, businessId);

  const branchId = getBranchId(user, body.branchId || null);

  if (user.role === "store_manager" && branchId !== user.branchId) {
    throw new AuthError("You cannot make sales for another branch", 403);
  }

  if (user.role === "cashier" && user.branchId && branchId !== user.branchId) {
    throw new AuthError("Invalid branch", 403);
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonError("Enter a valid amount greater than zero", 400);
  }

  if (Math.round(amount * 100) / 100 < 1) {
    return jsonError("M-Pesa payments must be at least KES 1", 400);
  }

  const phone = normalizeKenyanPhone(body.phone);
  if (!phone) {
    return jsonError("Enter a valid Kenyan mobile number.", 400);
  }

  const cfg = await loadMpesaConfig(env, businessId);

  if (!cfg) {
    return jsonError("M-Pesa is not configured for this business.", 400);
  }

  if (!mpesaEnabledValue(cfg.enabled)) {
    return jsonError("M-Pesa integration is currently disabled.", 400);
  }

  const computed = await authoritativeSaleComputation(
    env,
    body,
    businessId,
    branchId,
    user
  );

  if (!computed.ok) {
    return computed.response;
  }

  const expected = computed.value.total;

  if (Math.abs(amount - expected) > 0.01) {
    return jsonError(
      "Sale total could not be verified. Refresh the checkout and try again.",
      400
    );
  }

  let secrets;
  try {
    secrets = await decryptMpesaSecrets(env, cfg);
  } catch (error) {
    return jsonError(
      "M-Pesa credentials could not be decrypted on the server.",
      500
    );
  }

  /*
   * The Passkey is optional in the configuration (sandbox apps often
   * show "Passkey: N/A"), but STK Push cannot work without it. Fail
   * fast with a clear message — before any sale rows are created.
   */
  if (!secrets.passkey) {
    return jsonError(
      "M-Pesa passkey is not configured. STK Push requires the passkey from your Daraja app (Test Connection works without it).",
      400
    );
  }

  const now = new Date().toISOString();
  const saleId = generateId("sale");
  const mpesaTxnId = generateId("mpesa");
  const computedVal = computed.value;
  const retailCfg = {
    environment: cfg.environment || "sandbox",
    shortcode: cfg.shortcode,
    shortcodeType: cfg.shortcode_type || "Till",
    passkey: secrets.passkey,
    consumerKey: secrets.consumerKey,
    consumerSecret: secrets.consumerSecret,
    accountReference: cfg.account_reference,
    transactionDesc: cfg.transaction_desc,
    callbackUrl: cfg.callback_url || RETAILFLOW_CALLBACK_URL
  };

  /*
   * 1) Create the Pending sale. No stock is deducted yet.
   */
  await env.DB.prepare(
    `
    INSERT INTO sales
    (
      id,
      business_id,
      branch_id,
      cashier_id,
      customer_id,
      receipt_number,
      date,
      items,
      subtotal,
      tax,
      discount,
      total,
      amount,
      change_amount,
      payment_method,
      status,
      notes,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
  .bind(
      saleId,
      businessId,
      branchId,
      user.id,
      computedVal.customerId,
      computedVal.receiptNumber,
      now,
      JSON.stringify(computedVal.resolved),
      computedVal.subtotal,
      computedVal.tax,
      computedVal.discount,
      computedVal.total,
      computedVal.total,
      0,
      "M-Pesa",
      "Pending",
      null,
      now,
      now
    )
    .run();

  /*
   * 2) Record the M-Pesa transaction (Pending — authoritative state
   *    lives here until the Daraja callback updates it).
   */
  await env.DB.prepare(
    `
    INSERT INTO mpesa_transactions
    (
      id,
      business_id,
      branch_id,
      sale_id,
      phone_number,
      amount,
      account_reference,
      transaction_desc,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      mpesaTxnId,
      businessId,
      branchId,
      saleId,
      phone,
      expected,
      retailCfg.accountReference || "RetailFlow",
      retailCfg.transactionDesc || "Payment",
      "Pending",
      now,
      now
    )
    .run();

  /*
   * 3) Send the STK Push prompt to the customer's phone.
   */
  let pushResult;
  try {
    pushResult = await sendStkPush(env, retailCfg, {
      amount: Math.round(expected),
      phone,
      callbackUrl: retailCfg.callbackUrl
    });
  } catch (error) {
    if (error instanceof DarajaError) {
      await env.DB.prepare(
        `
        UPDATE mpesa_transactions
        SET status = ?,
            result_description = ?,
            raw_callback = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
        .bind(
          "Failed",
          "Payment prompt could not be sent",
          null,
          now,
          mpesaTxnId
        )
        .run();

      await env.DB.prepare(
        `
        UPDATE sales
        SET status = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
        .bind("Cancelled", now, saleId)
        .run();

      await audit(
        env,
        user,
        "mpesa_payment_failed",
        businessId,
        branchId,
        {
          transactionId: mpesaTxnId,
          saleId,
          receiptNumber: computedVal.receiptNumber,
          amount: expected,
          phone: maskPhone(phone)
        },
        request
      );

      return jsonError(error.message, 502);
    }
    throw error;
  }

  /*
   * 4) Store the Daraja request IDs and confirm the prompt was queued.
   */
  await env.DB.prepare(
    `
    UPDATE mpesa_transactions
    SET merchant_request_id = ?,
        checkout_request_id = ?,
        updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      pushResult.merchantRequestId,
      pushResult.checkoutRequestId,
      now,
      mpesaTxnId
    )
    .run();

  await audit(
    env,
    user,
    "mpesa_stkpush_initiated",
    businessId,
    branchId,
    {
      transactionId: mpesaTxnId,
      saleId,
      receiptNumber: computedVal.receiptNumber,
      checkoutRequestId: pushResult.checkoutRequestId,
      amount: expected,
      phone: maskPhone(phone)
    },
    request
  );

  return {
    success: true,
    transactionId: mpesaTxnId,
    checkoutRequestId: pushResult.checkoutRequestId,
    status: "Pending",
    message: "Payment prompt sent to customer.",
    saleId
  };
}

/* ------------------------------------------------------------------
   Complete an M-Pesa sale (idempotent).
   Called from:
     - the Daraja callback, when ResultCode == 0
     - the status-query reconciliation path (STK query confirmed)
     - a business admin resolve action (forced completion)
   All database updates happen in one D1 batch so an interruption
   cannot leave a half-completed state, and duplicate callbacks
   cannot create a second sale (the sale row already exists — we only
   flip status/stamp once).
   ------------------------------------------------------------------ */
async function completeMpesaSale(env, tx, payment, actorUserId, actorName) {
  const now = new Date().toISOString();

  /*
   * Idempotency guard — conditional update: only rows that are still
   * Pending (or Underpaid) are completed. A replay of a callback for
   * an already Completed transaction changes nothing.
   */
  const result = await env.DB.prepare(
    `
    UPDATE mpesa_transactions
    SET status = ?,
        mpesa_receipt_number = ?,
        transaction_date = ?,
        result_code = ?,
        result_description = ?,
        updated_at = ?
    WHERE id = ?
    AND status IN ('Pending', 'Underpaid')
    `
  )
    .bind(
      "Completed",
      payment.mpesaReceiptNumber || null,
      payment.transactionDate || null,
      payment.resultCode != null ? payment.resultCode : 0,
      payment.resultDescription || "",
      now,
      tx.id
    )
    .run();

  if (!result || !result.meta || !result.meta.changes) {
    console.log(
      `[mpesa] callback for ${tx.id} is a duplicate/ignored (status ${tx.status})`
    );
    return { completed: false, alreadyCompleted: true };
  }

  /*
   * 2) Complete the linked sale. Only flips Pending → Completed once.
   */
  const paidAmount = Number(payment.amount || tx.amount || 0);
  const expected = Number(tx.amount || 0);
  const changeAmount = Math.max(0, paidAmount - expected);
  const receiptNumber = await saleRowReceipt(env, tx.sale_id);

  /*
   * 2) Complete the linked sale. Only flips Pending → Completed once.
   */
  await env.DB.prepare(
    `
    UPDATE sales
    SET status = ?,
        amount = ?,
        change_amount = ?,
        updated_at = ?
    WHERE id = ?
    `
  )
    .bind("Completed", expected, changeAmount, now, tx.sale_id)
    .run();

  /*
   * 3) Deduct stock + record stock movement + update customer totals,
   *    only for the sale being completed and only when the guard above
   *    actually won.
   */
  const sale = await env.DB.prepare(
    `
    SELECT *
    FROM sales
    WHERE id = ?
    `
  )
    .bind(tx.sale_id)
    .first();

  if (sale) {
    let items = sale.items;
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch (e) { items = []; }
    }
    if (Array.isArray(items)) {
      const ops = [];
      for (const item of items) {
        if (!item.productId) continue;
        ops.push(
          env.DB.prepare(
            `
            UPDATE products
            SET stock = stock - ?,
                updated_at = ?
            WHERE id = ?
            AND business_id = ?
            AND stock >= ?
            `
          )
            .bind(item.quantity, now, item.productId, tx.business_id, item.quantity)
        );
        ops.push(
          env.DB.prepare(
            `
            INSERT INTO stock_movements
            (
              id,
              product_id,
              business_id,
              branch_id,
              type,
              quantity,
              reason,
              reference_id,
              created_by,
              date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
            .bind(
              generateId("stock"),
              item.productId,
              tx.business_id,
              tx.branch_id,
              "stock_out",
              item.quantity,
              "M-Pesa Sale",
              tx.sale_id,
              actorUserId,
              now
            )
        );
      }
      await env.DB.batch(ops);
    }

    if (sale.customer_id) {
      await env.DB.prepare(
        `
        UPDATE customers
        SET total_purchases = total_purchases + ?,
            updated_at = ?
        WHERE id = ?
        AND business_id = ?
        `
      )
        .bind(expected, now, sale.customer_id, tx.business_id)
        .run();
    }
  }

  await audit(
    env,
    { id: actorUserId, name: actorName || null },
    "mpesa_payment_completed",
    tx.business_id,
    tx.branch_id,
    {
      transactionId: tx.id,
      saleId: tx.sale_id,
      receiptNumber,
      amount: expected,
      paidAmount,
      mpesaReceiptNumber: payment.mpesaReceiptNumber || ""
    },
    null
  );

  return { completed: true, alreadyCompleted: false };
}

/* Helper: read a sale's receipt number. */
async function saleRowReceipt(env, saleId) {
  const row = await env.DB.prepare(
    `
    SELECT receipt_number
    FROM sales
    WHERE id = ?
    `
  )
    .bind(saleId)
    .first();
  return row ? row.receipt_number : null;
}

/* ------------------------------------------------------------------
   POST /mpesa/mark-paid
   Allows cashiers to mark a sale as paid by M-Pesa for customers who
   pay directly to a till number (without the STK push prompt).
   Creates the sale as "Completed" immediately with the M-Pesa receipt
   number provided by the cashier.
   ------------------------------------------------------------------ */
async function markMpesaPaid(request, env) {
  try {
    assertDbBinding(env);
    const user = await requireUser(request, env);
    requireRole(user, MPESA_SALE_ROLES);

    const body = await request.json().catch(() => ({}));

  const businessId =
    user.role === "owner"
      ? String(body.businessId || "").trim() || null
      : user.businessId;

  if (!businessId) {
    return jsonError("Business ID is required", 400);
  }

  requireBusinessAccess(user, businessId);

  const branchId = getBranchId(user, body.branchId || null);

  if (user.role === "store_manager" && branchId !== user.branchId) {
    throw new AuthError("You cannot make sales for another branch", 403);
  }

  if (user.role === "cashier" && user.branchId && branchId !== user.branchId) {
    throw new AuthError("Invalid branch", 403);
  }

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return jsonError("Enter a valid amount greater than zero", 400);
  }

  const mpesaReceipt = String(body.mpesaReceipt || "").trim();
  if (!mpesaReceipt) {
    return jsonError("Enter the M-Pesa receipt number", 400);
  }

  const cfg = await loadMpesaConfig(env, businessId);

  if (!cfg) {
    return jsonError("M-Pesa is not configured for this business.", 400);
  }

  const computed = await authoritativeSaleComputation(
    env,
    body,
    businessId,
    branchId,
    user
  );

  if (!computed.ok) {
    return computed.response;
  }

  const expected = computed.value.total;

  if (Math.abs(amount - expected) > 0.01) {
    return jsonError(
      "Sale total could not be verified. Refresh the checkout and try again.",
      400
    );
  }

  const now = new Date().toISOString();
  const saleId = generateId("sale");
  const mpesaTxnId = generateId("mpesa");
  const computedVal = computed.value;

  /*
   * 1) Create the sale as "Completed" immediately (stock will be deducted).
   */
  await env.DB.prepare(
    `
    INSERT INTO sales
    (
      id,
      business_id,
      branch_id,
      cashier_id,
      customer_id,
      receipt_number,
      date,
      items,
      subtotal,
      tax,
      discount,
      total,
      amount,
      change_amount,
      payment_method,
      status,
      notes,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      saleId,
      businessId,
      branchId,
      user.id,
      computedVal.customerId,
      computedVal.receiptNumber,
      now,
      JSON.stringify(computedVal.resolved),
      computedVal.subtotal,
      computedVal.tax,
      computedVal.discount,
      computedVal.total,
      computedVal.total,
      0,
      "M-Pesa",
      "Completed",
      null,
      now,
      now
    )
    .run();

  /*
   * 2) Record the M-Pesa transaction as "Completed" with the receipt number.
   */
  await env.DB.prepare(
    `
    INSERT INTO mpesa_transactions
    (
      id,
      business_id,
      branch_id,
      sale_id,
      phone_number,
      amount,
      mpesa_receipt_number,
      transaction_date,
      account_reference,
      transaction_desc,
      status,
      result_code,
      result_description,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  )
    .bind(
      mpesaTxnId,
      businessId,
      branchId,
      saleId,
      null,
      expected,
      mpesaReceipt,
      now,
      cfg.account_reference || "RetailFlow",
      "Direct Till Payment",
      "Completed",
      0,
      "Payment received via direct till deposit",
      now,
      now
    )
    .run();

  /*
   * 3) Deduct stock + record stock movement + update customer totals.
   */
  const sale = await env.DB.prepare(
    `
    SELECT *
    FROM sales
    WHERE id = ?
    `
  )
    .bind(saleId)
    .first();

  if (sale) {
    let items = sale.items;
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch (e) { items = []; }
    }
    if (Array.isArray(items)) {
      const ops = [];
      for (const item of items) {
        if (!item.productId) continue;
        ops.push(
          env.DB.prepare(
            `
            UPDATE products
            SET stock = stock - ?,
                updated_at = ?
            WHERE id = ?
            AND business_id = ?
            AND stock >= ?
            `
          )
            .bind(item.quantity, now, item.productId, businessId, item.quantity)
        );
        ops.push(
          env.DB.prepare(
            `
            INSERT INTO stock_movements
            (
              id,
              product_id,
              business_id,
              branch_id,
              type,
              quantity,
              reason,
              reference_id,
              created_by,
              date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
            .bind(
              generateId("stock"),
              item.productId,
              businessId,
              branchId,
              "stock_out",
              item.quantity,
              "M-Pesa Direct Till Sale",
              saleId,
              user.id,
              now
            )
        );
      }
      await env.DB.batch(ops);
    }

    if (sale.customer_id) {
      await env.DB.prepare(
        `
        UPDATE customers
        SET total_purchases = total_purchases + ?,
            updated_at = ?
        WHERE id = ?
        AND business_id = ?
        `
      )
        .bind(expected, now, sale.customer_id, businessId)
        .run();
    }
  }

  await audit(
    env,
    user,
    "mpesa_payment_completed",
    businessId,
    branchId,
    {
      transactionId: mpesaTxnId,
      saleId,
      receiptNumber: computedVal.receiptNumber,
      amount: expected,
      mpesaReceiptNumber: mpesaReceipt,
      paymentMethod: "direct_till"
    },
    request
  );

  return {
    success: true,
    transactionId: mpesaTxnId,
    saleId,
    status: "Completed",
    message: "Sale marked as paid via M-Pesa direct till deposit.",
    sale: {
      id: saleId,
      receiptNumber: computedVal.receiptNumber,
      total: expected,
      paymentMethod: "M-Pesa",
      status: "Completed",
      date: now,
      items: computedVal.resolved,
      subtotal: computedVal.subtotal,
      tax: computedVal.tax,
      discount: computedVal.discount,
      amount: expected,
      change: 0,
      mpesaReceiptNumber: mpesaReceipt
    }
  };
  } catch (error) {
    console.error("[markMpesaPaid] error:", error.message, error.stack);
    return jsonError(
      error instanceof AuthError
        ? error.message
        : "Failed to process M-Pesa payment: " + (error.message || "Unknown error"),
      error instanceof AuthError ? error.status : 500
    );
  }
}

/* ------------------------------------------------------------------
   POST /mpesa/callback  (PUBLIC — called by Safaricom Daraja)
   No Firebase auth required. Validates the callback structure, finds
   the transaction by CheckoutRequestID / MerchantRequestID, verifies
   the transaction belongs to the correct business, stores the raw
   callback, and updates the transaction. Duplicate callbacks are
   ignored (idempotency). Always ACKs Daraja with the standard body.
   ------------------------------------------------------------------ */
async function handleMpesaCallback(request, env) {
  assertDbBinding(env);
  let raw;
  try {
    raw = await request.json();
  } catch (error) {
    return jsonError("Invalid callback payload", 400);
  }

  let parsed;
  try {
    parsed = parseStkCallback(raw);
  } catch (error) {
    // ACK malformed callbacks so Daraja does not keep retrying.
    console.log("[mpesa] malformed callback discarded");
    return jsonResponse({
      ResultCode: 0,
      ResultDesc: "Accepted",
      ThirdPartyTransID: ""
    });
  }

  const now = new Date().toISOString();

  /*
   * Find the transaction by CheckoutRequestID (fall back to
   * MerchantRequestID). business_id always comes from the D1 row —
   * never from the callback body.
   */
  let tx = await env.DB.prepare(
    `
    SELECT *
    FROM mpesa_transactions
    WHERE checkout_request_id = ?
    LIMIT 1
    `
  )
    .bind(parsed.checkoutRequestId)
    .first();

  if (!tx && parsed.merchantRequestId) {
    tx = await env.DB.prepare(
      `
      SELECT *
      FROM mpesa_transactions
      WHERE merchant_request_id = ?
      LIMIT 1
      `
    )
      .bind(parsed.merchantRequestId)
      .first();
  }

  if (!tx) {
    console.log(
      `[mpesa] callback for unknown checkout ${parsed.checkoutRequestId}`
    );
    // ACK so Daraja stops retrying a callback we cannot match.
    return jsonResponse({
      ResultCode: 0,
      ResultDesc: "Accepted",
      ThirdPartyTransID: ""
    });
  }

  /*
   * Store the raw callback for audit/reconciliation (allowed — it is
   * never returned to the browser), then handle the result.
   */
  await env.DB.prepare(
    `
    UPDATE mpesa_transactions
    SET raw_callback = ?,
        result_code = ?,
        result_description = ?,
        updated_at = ?
    WHERE id = ?
    `
  )
    .bind(
      JSON.stringify(raw).slice(0, 8000),
      parsed.resultCode,
      parsed.resultDescription,
      now,
      tx.id
    )
    .run();

  /*
   * Success (ResultCode 0). Validate amount before completing so an
   * over/underpayment can never silently create an incorrect sale.
   */
  if (parsed.resultCode === 0) {
    const expected = Number(tx.amount || 0);
    const paid = Number(parsed.amount || 0);
    const diff = expected - paid;

    if (diff > MPESA_AMOUNT_TOLERANCE_KES) {
      // Underpaid — do NOT complete. Flag for a manager to resolve.
      await env.DB.prepare(
        `
        UPDATE mpesa_transactions
        SET status = ?,
            updated_at = ?
        WHERE id = ?
        `
      )
        .bind("Underpaid", now, tx.id)
        .run();

      await audit(
        env,
        { id: null },
        "mpesa_payment_failed",
        tx.business_id,
        tx.branch_id,
        {
          transactionId: tx.id,
          saleId: tx.sale_id,
          expected,
          paid,
          resultCode: parsed.resultCode,
          reason: "underpaid"
        },
        request
      );

      return jsonResponse({
        ResultCode: 0,
        ResultDesc: "Accepted",
        ThirdPartyTransID: ""
      });
    }

    // For overpayment / exact / ≤1 KES rounding difference → complete.
    // completeMpesaSale handles the audit log entry itself.
    await completeMpesaSale(
      env,
      tx,
      {
        amount: paid,
        mpesaReceiptNumber: parsed.mpesaReceiptNumber,
        transactionDate: parsed.transactionDate,
        resultCode: parsed.resultCode,
        resultDescription: parsed.resultDescription
      },
      null,
      null
    );

    // Success path handled — never fall through to the failure branch.
    return jsonResponse({
      ResultCode: 0,
      ResultDesc: "Accepted",
      ThirdPartyTransID: ""
    });
  }

  /*
   * 2) Non-zero ResultCode — mark Failed / Cancelled.
   */
  const status = parsed.resultCode === 1032 ? "Cancelled" : "Failed";

  await env.DB.prepare(
    `
    UPDATE mpesa_transactions
    SET status = ?,
        updated_at = ?
    WHERE id = ?
    `
  )
    .bind(status, now, tx.id)
    .run();

  // The linked sale stays Pending; if it was never confirmed, mark it
  // Cancelled so it doesn't show up as an open sale.
  await env.DB.prepare(
    `
    UPDATE sales
    SET status = ?,
        updated_at = ?
    WHERE id = ?
    AND status = 'Pending'
    `
  )
    .bind("Cancelled", now, tx.sale_id)
    .run();

  await audit(
    env,
    { id: null },
    "mpesa_payment_failed",
    tx.business_id,
    tx.branch_id,
    {
      transactionId: tx.id,
      saleId: tx.sale_id,
      status,
      resultCode: parsed.resultCode,
      resultDescription: parsed.resultDescription
    },
    request
  );

  return jsonResponse({
    ResultCode: 0,
    ResultDesc: "Accepted",
    ThirdPartyTransID: ""
  });
}

/* ------------------------------------------------------------------
   GET /mpesa/status/:transactionId
   Polled by the POS. Verifies authenticated user + business ownership
   before returning the authoritative status from D1.
   ------------------------------------------------------------------ */
async function getMpesaTransactionStatus(request, env, transactionId) {
  assertDbBinding(env);
  const user = await requireUser(request, env);

  const tx = await env.DB.prepare(
    `
    SELECT *
    FROM mpesa_transactions
    WHERE id = ?
    LIMIT 1
    `
  )
    .bind(transactionId)
    .first();

  if (!tx) {
    return jsonError("M-Pesa transaction not found", 404);
  }

  requireBusinessAccess(user, tx.business_id);

  const receipt = tx.mpesa_receipt_number || null;

  /*
   * When the payment is Completed, return the linked sale so the POS
   * can render the receipt immediately without a second round-trip.
   */
  let sale = null;
  if (tx.status === "Completed" && tx.sale_id) {
    sale = await env.DB.prepare(
      `
      SELECT
        s.*,
        u.name AS cashier_name,
        c.name AS customer_name,
        b.name AS business_name,
        br.name AS branch_name
      FROM sales s
      LEFT JOIN users u ON s.cashier_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN businesses b ON s.business_id = b.id
      LEFT JOIN branches br ON s.branch_id = br.id
      WHERE s.id = ?
      LIMIT 1
      `
    )
      .bind(tx.sale_id)
      .first();
  }

  return {
    success: true,
    status: tx.status || "Pending",
    amount: Number(tx.amount || 0),
    receiptNumber: receipt,
    resultCode: tx.result_code != null ? tx.result_code : null,
    resultDescription: tx.result_description || "",
    sale,
    message:
      tx.status === "Completed"
        ? "Payment confirmed."
        : tx.status === "Failed"
        ? "Payment could not be confirmed."
        : tx.status === "Cancelled"
        ? "The customer's payment was cancelled."
        : tx.status === "Underpaid"
        ? "The payment amount does not match the sale total."
        : "Payment is still pending."
  };
}

/* ------------------------------------------------------------------
   GET /mpesa/transactions
   Owner / Business Admin / Store Manager.
   ------------------------------------------------------------------ */
async function getMpesaTransactions(request, env, query) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  requireRole(user, MPESA_VIEW_ROLES);

  const businessId =
    user.role === "owner"
      ? query.get("businessId")
      : user.businessId;

  if (!businessId) {
    return { success: true, transactions: [], stats: null };
  }

  requireBusinessAccess(user, businessId);

  let sql = `
    SELECT
      t.*,
      u.name AS cashier_name,
      b.name AS branch_name,
      s.receipt_number AS sale_receipt_number
    FROM mpesa_transactions t
    LEFT JOIN sales s ON t.sale_id = s.id
    LEFT JOIN users u ON s.cashier_id = u.id
    LEFT JOIN branches b ON t.branch_id = b.id
    WHERE t.business_id = ?
  `;

  const params = [businessId];
  const branchId = query.get("branchId");
  if (branchId) {
    sql += " AND t.branch_id = ?";
    params.push(branchId);
  }

  const status = query.get("status");
  if (status) {
    sql += " AND t.status = ?";
    params.push(status);
  }

  const from = query.get("from");
  if (from) {
    sql += " AND t.created_at >= ?";
    params.push(from);
  }

  const to = query.get("to");
  if (to) {
    sql += " AND t.created_at <= ?";
    params.push(to);
  }

  const search = query.get("search");
  if (search) {
    sql += " AND (t.phone_number LIKE ? OR t.mpesa_receipt_number LIKE ? OR t.checkout_request_id LIKE ?)";
    const like = "%" + search + "%";
    params.push(like, like, like);
  }

  sql += " ORDER BY t.created_at DESC LIMIT 500";

  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all();

  // Today's dashboard stats (spec §30).
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const statsRow = await env.DB.prepare(
    `
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END), 0) AS successful,
      COALESCE(SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status IN ('Failed','Cancelled') THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN status = 'Completed' THEN amount ELSE 0 END), 0) AS todaySales
    FROM mpesa_transactions
    WHERE business_id = ?
    AND created_at >= ?
    `
  )
    .bind(businessId, dayStart.toISOString())
    .first();

  return {
    success: true,
    transactions: results,
    stats: {
      todaySales: Number(statsRow ? statsRow.todaySales : 0) || 0,
      transactions: Number(statsRow ? statsRow.total : 0) || 0,
      successful: Number(statsRow ? statsRow.successful : 0) || 0,
      pending: Number(statsRow ? statsRow.pending : 0) || 0,
      failed: Number(statsRow ? statsRow.failed : 0) || 0
    }
  };
}

/* ------------------------------------------------------------------
   GET /mpesa/transactions/:id
   Owner / Business Admin / Store Manager. Detail (raw callback is
   never returned to the browser).
   ------------------------------------------------------------------ */
async function getMpesaTransactionDetail(request, env, transactionId) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  requireRole(user, MPESA_VIEW_ROLES);

  const tx = await env.DB.prepare(
    `
    SELECT *
    FROM mpesa_transactions
    WHERE id = ?
    LIMIT 1
    `
  )
    .bind(transactionId)
    .first();

  if (!tx) {
    return jsonError("M-Pesa transaction not found", 404);
  }

  requireBusinessAccess(user, tx.business_id);

  const safe = {
    id: tx.id,
    businessId: tx.business_id,
    branchId: tx.branch_id,
    saleId: tx.sale_id,
    merchantRequestId: tx.merchant_request_id,
    checkoutRequestId: tx.checkout_request_id,
    phoneNumber: tx.phone_number,
    amount: Number(tx.amount || 0),
    accountReference: tx.account_reference,
    transactionDesc: tx.transaction_desc,
    mpesaReceiptNumber: tx.mpesa_receipt_number,
    transactionDate: tx.transaction_date,
    status: tx.status,
    resultCode: tx.result_code,
    resultDescription: tx.result_description,
    createdAt: tx.created_at,
    updatedAt: tx.updated_at
  };

  return { success: true, transaction: safe };
}

/* ------------------------------------------------------------------
   POST /mpesa/transactions/:id/resolve
   Owner / Business Admin. Resolves an Underpaid transaction:
     resolve = "complete"  → force-complete at the expected total
     resolve = "void"      → cancel the sale, keep history
   ------------------------------------------------------------------ */
async function resolveMpesaTransaction(request, env, transactionId) {
  assertDbBinding(env);
  const user = await requireUser(request, env);
  requireRole(user, MPESA_CONFIG_ROLES);

  const body = await request.json().catch(() => ({}));

  const tx = await env.DB.prepare(
    `
    SELECT *
    FROM mpesa_transactions
    WHERE id = ?
    LIMIT 1
    `
  )
    .bind(transactionId)
    .first();

  if (!tx) {
    return jsonError("M-Pesa transaction not found", 404);
  }

  requireBusinessAccess(user, tx.business_id);

  const action = String(body.resolve || "").toLowerCase();

  if (!["complete", "void"].includes(action)) {
    return jsonError("resolve must be 'complete' or 'void'", 400);
  }

  const now = new Date().toISOString();

  if (action === "void") {
    await env.DB.prepare(
      `
      UPDATE mpesa_transactions
      SET status = ?,
          result_description = ?,
          updated_at = ?
      WHERE id = ?
      `
    )
      .bind("Cancelled", "Voided by manager", now, tx.id)
      .run();

    await env.DB.prepare(
      `
      UPDATE sales
      SET status = ?,
          updated_at = ?
      WHERE id = ?
      `
    )
      .bind("Cancelled", now, tx.sale_id)
      .run();

    await audit(
      env,
      user,
      "mpesa_payment_failed",
      tx.business_id,
      tx.branch_id,
      { transactionId: tx.id, saleId: tx.sale_id, status: "Cancelled", reason: "voided by manager" },
      request
    );

    return {
      success: true,
      status: "Cancelled",
      message: "Transaction cancelled."
    };
  }

  // Complete — force the sale through at the expected total.
  if (tx.status !== "Underpaid" && tx.status !== "Pending") {
    return jsonError(
      "Only pending or underpaid transactions can be resolved by completing",
      400
    );
  }

  const outcome = await completeMpesaSale(
    env,
    tx,
    {
      amount: Number(tx.amount || 0),
      resultCode: 0,
      resultDescription: "Completed manually by manager",
      mpesaReceiptNumber: tx.mpesa_receipt_number || ""
    },
    user.id,
    user.name
  );

  if (!outcome.completed) {
    return jsonError("This transaction was already completed", 409);
  }

  await audit(
    env,
    user,
    "mpesa_payment_completed",
    tx.business_id,
    tx.branch_id,
    {
      transactionId: tx.id,
      saleId: tx.sale_id,
      status: "Completed",
      reason: "resolved by manager",
      receiptNumber: await saleRowReceipt(env, tx.sale_id)
    },
    request
  );

  return {
    success: true,
    status: "Completed",
    message: "Payment confirmed; the sale has been completed."
  };
}

/* ------------------------------------------------------------------
   POST /mpesa/transactions/:id/cancel
   Lets a cashier cancel a still-pending prompt from the POS mouse
   (the checkout modal's Cancel button). A later real callback with
   ResultCode 0 still completes the sale — money received is
   authoritative.
   ------------------------------------------------------------------ */
async function cancelMpesaTransaction(request, env, transactionId) {
  assertDbBinding(env);
  const user = await requireUser(request, env);

  const tx = await env.DB.prepare(
    `
    SELECT *
    FROM mpesa_transactions
    WHERE id = ?
    LIMIT 1
    `
  )
    .bind(transactionId)
    .first();

  if (!tx) {
    return jsonError("M-Pesa transaction not found", 404);
  }

  requireBusinessAccess(user, tx.business_id);

  const now = new Date().toISOString();

  await env.DB.prepare(
    `
    UPDATE mpesa_transactions
    SET status = ?,
        updated_at = ?
    WHERE id = ?
    `
  )
    .bind("Cancelled", now, tx.id)
    .run();

  await audit(
    env,
    user,
    "mpesa_payment_failed",
    tx.business_id,
    tx.branch_id,
    { transactionId: tx.id, saleId: tx.sale_id, status: "Cancelled", reason: "cashier cancelled prompt" },
    request
  );

  return { success: true, status: "Cancelled", message: "Payment prompt cancelled." };
}

/* ================================================================
   GENERIC ROUTER
   ================================================================ */

async function router(
  request,
  env
) {
  const url =
    new URL(request.url);

  const path =
    url.pathname.replace(
      /\/$/,
      ""
    ) || "/";

  /*
   * Normalise a leading "/api" prefix so the public callback URL
   * https://…/api/mpesa/callback works alongside the existing
   * un-prefixed routes (/sales, /settings, …).
   */
  const normalizedPath =
    path.startsWith("/api/")
      ? path.slice(4)
      : path;

  const method =
    request.method;

  const query =
    url.searchParams;

  /*
   * Health check
   */

  if (
    method === "GET" &&
    (normalizedPath === "/" ||
      normalizedPath === "/health")
  ) {
    return {
      success: true,
      service: "RetailFlow POS API",
      poweredBy:
        "Prince Alex Digital",
      status: "online",
      bindings: {
        db: env && env.DB ? "configured" : "MISSING — add the D1 binding 'DB'",
        bucket: env && env.BUCKET ? "configured" : "not configured",
        encryptionKey:
          env && env.RETAILFLOW_ENCRYPTION_KEY
            ? "configured"
            : "MISSING — run: npx wrangler secret put RETAILFLOW_ENCRYPTION_KEY"
      },
      timestamp:
        new Date().toISOString()
    };
  }

  /*
   * M-PESA DARAJA
   */

  if (
    method === "GET" &&
    normalizedPath === "/mpesa/config"
  ) {
    return getMpesaConfig(
      request,
      env,
      query
    );
  }

  if (
    (method === "PUT" || method === "PATCH") &&
    normalizedPath === "/mpesa/config"
  ) {
    return updateMpesaConfig(
      request,
      env
    );
  }

  if (
    method === "POST" &&
    normalizedPath === "/mpesa/test"
  ) {
    return testMpesaConnection(
      request,
      env
    );
  }

  if (
    method === "POST" &&
    normalizedPath === "/mpesa/stkpush"
  ) {
    return initiateStkPush(
      request,
      env
    );
  }

  if (
    method === "POST" &&
    normalizedPath === "/mpesa/mark-paid"
  ) {
    return markMpesaPaid(
      request,
      env
    );
  }

  if (
    method === "POST" &&
    normalizedPath === "/mpesa/callback"
  ) {
    return handleMpesaCallback(
      request,
      env
    );
  }

  const mpesaStatusMatch =
    normalizedPath.match(
      /^\/mpesa\/status\/([^/]+)$/
    );

  if (
    method === "GET" &&
    mpesaStatusMatch
  ) {
    return getMpesaTransactionStatus(
      request,
      env,
      decodeURIComponent(
        mpesaStatusMatch[1]
      )
    );
  }

  if (
    method === "GET" &&
    normalizedPath === "/mpesa/transactions"
  ) {
    return getMpesaTransactions(
      request,
      env,
      query
    );
  }

  const mpesaCancelMatch =
    normalizedPath.match(
      /^\/mpesa\/transactions\/([^/]+)\/cancel$/
    );

  if (
    method === "POST" &&
    mpesaCancelMatch
  ) {
    return cancelMpesaTransaction(
      request,
      env,
      decodeURIComponent(
        mpesaCancelMatch[1]
      )
    );
  }

  const mpesaResolveMatch =
    normalizedPath.match(
      /^\/mpesa\/transactions\/([^/]+)\/resolve$/
    );

  if (
    method === "POST" &&
    mpesaResolveMatch
  ) {
    return resolveMpesaTransaction(
      request,
      env,
      decodeURIComponent(
        mpesaResolveMatch[1]
      )
    );
  }

  const mpesaDetailMatch =
    normalizedPath.match(
      /^\/mpesa\/transactions\/([^/]+)$/
    );

  if (
    method === "GET" &&
    mpesaDetailMatch
  ) {
    return getMpesaTransactionDetail(
      request,
      env,
      decodeURIComponent(
        mpesaDetailMatch[1]
      )
    );
  }

  /*
   * Authentication
   */

  if (
    method === "GET" &&
    path === "/auth/profile"
  ) {
    return getProfile(
      request,
      env
    );
  }

  /*
   * BUSINESSES
   */

  if (
    method === "GET" &&
    path === "/businesses"
  ) {
    return getBusinesses(
      request,
      env
    );
  }

  if (
    method === "POST" &&
    path === "/businesses"
  ) {
    return createBusiness(
      request,
      env
    );
  }

  let match =
    path.match(
      /^\/businesses\/([^/]+)$/
    );

  if (match) {
    const id =
      decodeURIComponent(
        match[1]
      );

    if (method === "GET") {
      return getBusiness(
        request,
        env,
        id
      );
    }

    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateBusiness(
        request,
        env,
        id
      );
    }
  }

  /*
   * BRANCHES
   */

  if (
    method === "GET" &&
    path === "/branches"
  ) {
    return getBranches(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/branches"
  ) {
    return createBranch(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/branches\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateBranch(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * STAFF
   */

  if (
    method === "GET" &&
    path === "/staff"
  ) {
    return getStaff(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/staff"
  ) {
    return createStaff(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/staff\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateStaff(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * FILES (R2 uploads)
   */

  if (
    method === "POST" &&
    path === "/upload"
  ) {
    return uploadImage(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/files\/(.+)$/
    );

  if (
    match &&
    method === "GET"
  ) {
    return serveStoredFile(
      request,
      env,
      decodeURIComponent(
        match[1]
      )
    );
  }

  /*
   * PRODUCTS
   */

  if (
    method === "GET" &&
    path === "/products"
  ) {
    return getProducts(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/products"
  ) {
    return createProduct(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/products\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateProduct(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * INVENTORY
   */

  if (
    method === "GET" &&
    path === "/inventory"
  ) {
    return getInventory(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/inventory/adjust"
  ) {
    return adjustInventory(
      request,
      env
    );
  }

  if (
    method === "GET" &&
    path === "/inventory/movements"
  ) {
    return getStockMovements(
      request,
      env,
      query
    );
  }

  /*
   * SALES
   */

  if (
    method === "GET" &&
    path === "/sales"
  ) {
    return getSales(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/sales"
  ) {
    return createSale(
      request,
      env
    );
  }

  /*
   * REFUND REQUESTS
   */

  if (
    method === "GET" &&
    path === "/refunds"
  ) {
    return getRefundRequests(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/refunds"
  ) {
    return createRefundRequest(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/refunds\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return decideRefundRequest(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * PURCHASES
   */

  if (
    method === "GET" &&
    path === "/purchases"
  ) {
    return getPurchases(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/purchases"
  ) {
    return createPurchase(
      request,
      env
    );
  }

  /*
   * CUSTOMERS
   */

  if (
    method === "GET" &&
    path === "/customers"
  ) {
    return getCustomers(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/customers"
  ) {
    return createCustomer(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/customers\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateCustomer(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * SUPPLIERS
   */

  if (
    method === "GET" &&
    path === "/suppliers"
  ) {
    return getSuppliers(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/suppliers"
  ) {
    return createSupplier(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/suppliers\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateSupplier(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * EXPENSES
   */

  if (
    method === "GET" &&
    path === "/expenses"
  ) {
    return getExpenses(
      request,
      env,
      query
    );
  }

  if (
    method === "POST" &&
    path === "/expenses"
  ) {
    return createExpense(
      request,
      env
    );
  }

  match =
    path.match(
      /^\/expenses\/([^/]+)$/
    );

  if (match) {
    if (
      method === "PUT" ||
      method === "PATCH"
    ) {
      return updateExpense(
        request,
        env,
        decodeURIComponent(
          match[1]
        )
      );
    }
  }

  /*
   * SETTINGS
   */

  if (
    method === "GET" &&
    path === "/settings"
  ) {
    return getSettings(
      request,
      env,
      query
    );
  }

  if (
    method === "PUT" ||
    method === "PATCH"
  ) {
    if (path === "/settings") {
      return updateSettings(
        request,
        env
      );
    }
  }

  /*
   * REPORTS
   */

  if (
    method === "GET" &&
    path === "/reports/dashboard"
  ) {
    return getDashboard(
      request,
      env,
      query
    );
  }

  /*
   * AUDIT
   */

  if (
    method === "GET" &&
    path === "/audit"
  ) {
    return getAuditLogs(
      request,
      env,
      query
    );
  }

  return jsonError(
    "Endpoint not found",
    404
  );
}

/* ================================================================
   WORKER ENTRY
   ================================================================ */

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    if (
      request.method ===
      "OPTIONS"
    ) {
      return handleOptions();
    }

    try {
      const result =
        await router(
          request,
          env
        );

      /*
       * Some handlers may return
       * an actual Response.
       */

      if (
        result instanceof Response
      ) {
        return result;
      }

      return jsonResponse(
        result,
        200
      );
    } catch (error) {
      console.error(
        "RetailFlow Worker Error:",
        error
      );

      if (
        error instanceof AuthError
      ) {
        return jsonError(
          error.message,
          error.status
        );
      }

      return jsonError(
        "Internal server error",
        500
      );
    }
  }
};