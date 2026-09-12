import { describe, it, expect } from "vitest";
import { envelope } from "../src/services/crypto.service.js";

// Write-only envelope encryption: createUser persists these blobs and no
// code path ever reads them back, so there is intentionally no decrypt API.
// These tests pin the documented ciphertext format without inventing one.
describe("envelope encryption format", () => {
  it("produces AES-256-GCM parts with the documented sizes", () => {
    const e = envelope("Ada Lovelace", "+8801700000000");
    expect(Buffer.isBuffer(e.name.ciphertext)).toBe(true);
    expect(e.name.iv).toHaveLength(12);
    expect(e.name.tag).toHaveLength(16);
    expect(e.phone?.iv).toHaveLength(12);
    expect(e.phone?.tag).toHaveLength(16);
    // wrapped = iv(12) + authTag(16) + encrypted DEK(32)
    expect(e.wrapped).toHaveLength(60);
  });

  it("omits phone parts when no phone is given", () => {
    const e = envelope("Ada Lovelace");
    expect(e.phone).toBeUndefined();
    expect(e.wrapped).toHaveLength(60);
  });

  it("is nondeterministic: same plaintext never yields the same bytes", () => {
    const a = envelope("Ada Lovelace", "+8801700000000");
    const b = envelope("Ada Lovelace", "+8801700000000");
    expect(a.name.ciphertext.equals(b.name.ciphertext)).toBe(false);
    expect(a.wrapped.equals(b.wrapped)).toBe(false);
  });

  it("different plaintext encrypts to different ciphertext", () => {
    const a = envelope("Ada Lovelace");
    const b = envelope("Grace Hopper");
    expect(a.name.ciphertext.equals(b.name.ciphertext)).toBe(false);
  });
});
