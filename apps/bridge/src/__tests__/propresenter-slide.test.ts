import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseSlidePair } from "../protocols/propresenter-slide.js";
import { ProPresenterBridge } from "../protocols/propresenter.js";

describe("ProPresenter confidence pairs", () => {
  it("reads the documented current/next shape, including current notes and stable identities", () => {
    expect(
      parseSlidePair({
        current: {
          text: "The LORD is my shepherd",
          notes: "Psalm 23:1",
          uuid: "one",
        },
        next: {
          text: "He maketh me to lie down",
          notes: "Psalm 23:2",
          uuid: "two",
        },
      }),
    ).toEqual({
      text: "The LORD is my shepherd",
      notes: "Psalm 23:1",
      presentationName: "",
      isScripture: true,
      slideId: "one",
      nextText: "He maketh me to lie down",
      nextSlideId: "two",
    });
  });
  it("distinguishes a cleared current slide from an unsupported response", () => {
    expect(
      parseSlidePair({
        current: { text: "", uuid: "" },
        next: { text: "Do not display yet" },
      }),
    ).toBeNull();
    expect(parseSlidePair({ current: null })).toBeNull();
    expect(parseSlidePair({ text: "Legacy response" })).toBeUndefined();
  });
  it("relays next-only changes and never revives a clear from a stale fallback endpoint", async () => {
    let payload: unknown = {
      current: { text: "Current", notes: "", uuid: "c" },
      next: { text: "Upcoming", notes: "", uuid: "n" },
    };
    let fallbackRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/status/slide")
        response.end(JSON.stringify(payload));
      else {
        fallbackRequests++;
        response.end(JSON.stringify({ text: "Stale text" }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server did not start");
    const slides: (Record<string, unknown> | null)[] = [];
    const bridge = new ProPresenterBridge({
      host: "127.0.0.1",
      port: address.port,
      apiPort: address.port,
      onSlideChange: (slide) => slides.push(slide),
      onStatusChange: () => {},
    });
    try {
      bridge.connect();
      await expect.poll(() => slides.at(-1)?.nextText).toBe("Upcoming");
      payload = {
        current: { text: "Current", notes: "", uuid: "c" },
        next: { text: "Edited upcoming", notes: "", uuid: "n" },
      };
      await expect.poll(() => slides.at(-1)?.nextText).toBe("Edited upcoming");
      payload = {
        current: { text: "", notes: "", uuid: "" },
        next: { text: "" },
      };
      await expect.poll(() => slides.at(-1), { timeout: 3000 }).toBeNull();
      expect(fallbackRequests).toBe(0);
    } finally {
      bridge.disconnect();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
