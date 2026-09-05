/**
 * ================================================================
 * RetailFlow — daraja.js
 * ----------------------------------------------------------------
 * ALL Safaricom Daraja (M-Pesa) communication is isolated here so
 * it can be updated to match the current official API without
 * touching the POS frontend or the rest of the Worker.
 *
 * Sources of truth (current official Daraja v1 API):
 *   https://developer.safaricom.co.ke
 *
 * OAuth:
 *   GET  {base}/oauth/v1/generate?grant_type=client_credentials
 *   Authorization: Basic base64(consumerKey:consumerSecret)
 *
 * STK Push (Lipa na M-Pesa Online):
 *   POST {base}/mpesa/stkpush/v1/processrequest
 *   Password = base64(shortcode + passkey + Timestamp)
 *   Timestamp = YYYYMMDDHHmmss in Kenya time (UTC+3)
 *   TransactionType:
 *     CustomerBuyGoodsOnline  → Till Number
 *     CustomerPayBillOnline   → PayBill
 *   PartyB  = shortcode
 *   PartyA  = customer phone (2547XXXXXXXX / 2541XXXXXXXX)
 *
 * STK Push Query (reconciliation):
 *   POST {base}/mpesa/stkpushquery/v1/query
 *   { BusinessShortCode, Password, Timestamp, CheckoutRequestID }
 *
 * Callback (Safaricom → RetailFlow):
 *   Body.stkCallback {
 *     MerchantRequestID, CheckoutRequestID,
 *     ResultCode, ResultDesc,
 *     CallbackMetadata.Item[]  → { Name, Value }
 *   }
 *   ResultCode 0 = success; 1032 = cancelled by customer.
 *
 * SECURITY: this module never logs or returns tokens, secrets,
 * passwords or raw authorization headers. Phone numbers are masked
 * through maskPhone() for logs/audit.
 * ================================================================
 */

const DARAJA_BASE = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke"
};

const KENYA_UTC_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, no DST

/** Friendly error whose message is always safe to show users. */
export class DarajaError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "DarajaError";
    this.status = status;
  }
}

/** Resolve the Daraja base URL for a saved environment. */
export function darajaBase(environment) {
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
export function formatKenyanTimestamp(date = new Date()) {
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
export function generateStkPassword(shortcode, passkey, timestamp) {
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
export function normalizeKenyanPhone(input) {
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
export function maskPhone(input) {
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
export async function getOAuthToken(env, cfg) {
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
export async function sendStkPush(env, cfg, pay) {
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
export async function queryStkStatus(env, cfg, checkoutRequestId) {
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
export function parseStkCallback(raw) {
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