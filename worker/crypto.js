/**
 * ================================================================
 * RetailFlow — crypto.js
 * ----------------------------------------------------------------
 * Authenticated encryption (AES-256-GCM) for M-Pesa Daraja secrets
 * (Consumer Key, Consumer Secret, Passkey) before they are stored
 * in D1.
 *
 * The master key lives ONLY in the Cloudflare Worker secret
 * `RETAILFLOW_ENCRYPTION_KEY`. It is never stored in D1 and never
 * exposed to frontend JavaScript.
 *
 * Format of an encrypted value stored in D1:
 *   v1.<base64url(iv)>.<base64url(ciphertext + auth_tag)>
 *
 * - v1        version prefix (allows safe key rotation later)
 * - iv        12-byte random nonce
 * - ciphertext WebCrypto AES-GCM output includes the 16-byte
 *              authentication tag at the end
 *
 * Decryption fails loudly (auth tag mismatch) if the value was
 * tampered with or the wrong key is used.
 * ================================================================
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
async function getKey(env) {
  const secret =
    (env && env.RETAILFLOW_ENCRYPTION_KEY) || "";
  if (!secret || secret.length < 32) {
    throw new Error(
      "Encryption is not configured — set the RETAILFLOW_ENCRYPTION_KEY Worker secret"
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(secret)
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
export async function encryptSecret(value, env) {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(String(value == null ? "" : value))
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
export async function decryptSecret(payload, env) {
  if (!payload || typeof payload !== "string") {
    throw new Error("Invalid encrypted value");
  }
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted value format");
  }
  const iv = b64urlDecode(parts[1]);
  const data = b64urlDecode(parts[2]);
  const key = await getKey(env);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    return decoder.decode(plaintext);
  } catch (error) {
    throw new Error(
      "Unable to decrypt stored credentials — check RETAILFLOW_ENCRYPTION_KEY"
    );
  }
}