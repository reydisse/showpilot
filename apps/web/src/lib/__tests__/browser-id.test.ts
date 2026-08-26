import { describe, expect, it } from "vitest";
import { createBrowserId } from "@/lib/browser-id";

describe("createBrowserId", () => {
  it("uses randomUUID in secure contexts", () => {
    expect(
      createBrowserId({
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
      }),
    ).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("uses random bytes when randomUUID is unavailable on LAN HTTP", () => {
    const source = {
      getRandomValues(values: Uint32Array) {
        values.set([1, 2, 3, 4]);
        return values;
      },
    };
    expect(createBrowserId(source)).toBe("1-2-3-4");
  });

  it("keeps a bounded fallback for unusually old browser shells", () => {
    expect(createBrowserId({})).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
