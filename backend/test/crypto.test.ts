import { describe, it, expect } from "vitest";
import { encryptCleanverseBody, decryptCleanverseBody } from "../src/cleanverse/crypto.js";
import { randomBytes } from "node:crypto";

describe("Cleanverse AES-CBC encryption (AES/CBC/PKCS5Padding, fixed zero IV)", () => {
  it("round-trips a plaintext object through encrypt then decrypt", () => {
    const key = randomBytes(32).toString("base64"); // AES-256 key
    const payload = { customerId: "TESTCUSTOMER01", subTier: 9, wallet: { address: "0xabc", chain: "monad" } };

    const encrypted = encryptCleanverseBody(payload, key);
    expect(encrypted.data).toBeTruthy();
    expect(typeof encrypted.data).toBe("string");

    const decrypted = decryptCleanverseBody<typeof payload>(encrypted.data, key);
    expect(decrypted).toEqual(payload);
  });

  it("produces different ciphertext for different plaintexts with the same key (not a no-op)", () => {
    const key = randomBytes(32).toString("base64");
    const a = encryptCleanverseBody({ a: 1 }, key);
    const b = encryptCleanverseBody({ a: 2 }, key);
    expect(a.data).not.toBe(b.data);
  });

  it("works with AES-128 (16-byte key) as well as AES-256 (32-byte key)", () => {
    const key128 = randomBytes(16).toString("base64");
    const payload = { hello: "world" };
    const encrypted = encryptCleanverseBody(payload, key128);
    const decrypted = decryptCleanverseBody<typeof payload>(encrypted.data, key128);
    expect(decrypted).toEqual(payload);
  });

  it("fails to decrypt with the wrong key (proves the key actually matters)", () => {
    const key1 = randomBytes(32).toString("base64");
    const key2 = randomBytes(32).toString("base64");
    const encrypted = encryptCleanverseBody({ secret: true }, key1);
    expect(() => decryptCleanverseBody(encrypted.data, key2)).toThrow();
  });
});
