import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH } from "@showpilot/shared";

describe("account password policy", () => {
  it("matches Better Auth's configured eight-character minimum", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
  });
});
