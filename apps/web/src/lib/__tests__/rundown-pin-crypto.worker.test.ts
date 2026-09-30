import { describe, expect, it, vi } from "vitest";
import { hashRundownPin, verifyStoredRundownPin } from "../rundown-pin-crypto";

// Generated independently with Node's PBKDF2 before switching implementations.
const existingHash = "pbkdf2-sha256:210000:MDEyMzQ1Njc4OWFiY2RlZg:dn1Cq81hnTfBlkh2maxSEZ3GzIkOQC9w2mVohTIJ_uo";

describe("rundown PINs in Workers", { timeout: 15_000 }, () => {
  it("creates and verifies PIN hashes without the capped Web Crypto API", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("Pbkdf2 failed: iteration counts above 100000 are not supported"));
    try {
      const hash = await hashRundownPin("2468");
      expect(hash).toMatch(/^pbkdf2-sha256:210000:/);
      await expect(verifyStoredRundownPin("2468", hash)).resolves.toBe(true);
      await expect(verifyStoredRundownPin("1357", hash)).resolves.toBe(false);
      expect(derive).not.toHaveBeenCalled();
    } finally { derive.mockRestore(); }
  });
  it("preserves existing 210,000-iteration hashes", async () => {
    await expect(verifyStoredRundownPin("2468", existingHash)).resolves.toBe(true);
    await expect(verifyStoredRundownPin("1357", existingHash)).resolves.toBe(false);
  });
  it("rejects excessive work factors and malformed lengths without hashing", async () => {
    await expect(verifyStoredRundownPin("2468", existingHash.replace(":210000:", ":999999999:"))).resolves.toBe(false);
    await expect(verifyStoredRundownPin("2468", "pbkdf2-sha256:210000:YWJj:YWJj")).resolves.toBe(false);
  });
});
