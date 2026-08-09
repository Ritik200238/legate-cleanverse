import { createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AES encryption for Cleanverse's encrypted-body endpoints (generate_apass, update_status,
 * atoken/* mutations, validator/grant, validator/register, validator/set_rule, etc.).
 *
 * Spec, taken verbatim from CLEANVERSE_API.md's "Encryption" section — not guessed:
 *   Algorithm:      AES
 *   Cipher Mode:    AES/CBC/PKCS5Padding
 *   Cipher IV:      fixed IV of 16 zero bytes
 *   Key Source:     Base64-decoded api-key
 *   Encoding:       Base64
 *   Character Set:  UTF-8
 *
 * Node's `aes-128-cbc` / `aes-256-cbc` ciphers apply PKCS#7 padding by default, which is
 * byte-for-byte identical to PKCS#5 padding for a 16-byte AES block size — so no special
 * padding handling is needed beyond leaving auto-padding on (the default).
 */

const FIXED_IV = Buffer.alloc(16, 0); // 16 zero bytes, per the doc

function algorithmForKey(key: Buffer): "aes-128-cbc" | "aes-192-cbc" | "aes-256-cbc" {
  switch (key.length) {
    case 16:
      return "aes-128-cbc";
    case 24:
      return "aes-192-cbc";
    case 32:
      return "aes-256-cbc";
    default:
      throw new Error(
        `Unexpected Cleanverse api-key length after Base64 decode: ${key.length} bytes (expected 16, 24, or 32 for AES-128/192/256)`,
      );
  }
}

/** Encrypts a plaintext JSON object into the `{"data": "<base64>"}` envelope Cleanverse expects. */
export function encryptCleanverseBody(plaintextObject: unknown, apiKeyBase64: string): { data: string } {
  const key = Buffer.from(apiKeyBase64, "base64");
  const algorithm = algorithmForKey(key);
  const cipher = createCipheriv(algorithm, key, FIXED_IV);
  const plaintext = Buffer.from(JSON.stringify(plaintextObject), "utf-8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { data: encrypted.toString("base64") };
}

/** Decrypts a Cleanverse `{"data": "<base64>"}` response envelope back into a JS object, if ever needed. */
export function decryptCleanverseBody<T = unknown>(base64Ciphertext: string, apiKeyBase64: string): T {
  const key = Buffer.from(apiKeyBase64, "base64");
  const algorithm = algorithmForKey(key);
  const decipher = createDecipheriv(algorithm, key, FIXED_IV);
  const ciphertext = Buffer.from(base64Ciphertext, "base64");
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString("utf-8")) as T;
}
