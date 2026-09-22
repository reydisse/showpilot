import { describe, expect, it } from "vitest";
import {
  hashRundownPin,
  isHashedRundownPin,
  verifyStoredRundownPin,
} from "../rundown-pin-crypto";

describe("rundown PIN storage", () => {
  it("stores a salted hash and verifies only the matching PIN", async () => {
    const stored = await hashRundownPin("2468");

    expect(stored).not.toContain("2468");
    expect(isHashedRundownPin(stored)).toBe(true);
    await expect(verifyStoredRundownPin("2468", stored)).resolves.toBe(true);
    await expect(verifyStoredRundownPin("1357", stored)).resolves.toBe(false);
    await expect(verifyStoredRundownPin(null, stored)).resolves.toBe(false);
  });

  it("accepts an unconfigured PIN and supports legacy plaintext during migration", async () => {
    await expect(verifyStoredRundownPin(null, null)).resolves.toBe(true);
    await expect(verifyStoredRundownPin("2468", "2468")).resolves.toBe(true);
    await expect(verifyStoredRundownPin("1357", "2468")).resolves.toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    await expect(
      verifyStoredRundownPin("2468", "pbkdf2-sha256:1:not-a-salt:not-a-hash"),
    ).resolves.toBe(false);
  });
});
