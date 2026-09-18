import { describe, expect, it } from "vitest";
import { readRequestJsonWithinLimit, readRequestTextWithinLimit } from "../request-body.server";

describe("bounded request body parsing", () => {
  it("parses JSON within the byte limit", async () => {
    const request = new Request("https://showpilot.tech/api/test", {
      method: "POST",
      body: JSON.stringify({ value: "safe" }),
    });

    await expect(readRequestJsonWithinLimit(request, 100)).resolves.toEqual({
      ok: true,
      value: { value: "safe" },
    });
  });

  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request("https://showpilot.tech/api/test", {
      method: "POST",
      headers: { "Content-Length": "101" },
      body: "small",
    });

    await expect(readRequestTextWithinLimit(request, 100)).resolves.toEqual({
      ok: false,
      status: 413,
    });
  });

  it("stops a streamed body when its actual bytes exceed the limit", async () => {
    const request = new Request("https://showpilot.tech/api/test", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"));
          controller.enqueue(new TextEncoder().encode("67890"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(readRequestTextWithinLimit(request, 8)).resolves.toEqual({
      ok: false,
      status: 413,
    });
  });
});
