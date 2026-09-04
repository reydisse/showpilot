import { afterEach, describe, expect, it, vi } from "vitest";
import { ProPresenterClient, type PPConnectionStatus } from "@/lib/propresenter-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProPresenterClient", () => {
  it("does not open the legacy Stage Display WebSocket on a shared API port", async () => {
    const websocket = vi.fn();
    vi.stubGlobal("WebSocket", websocket);
    const statuses: PPConnectionStatus[] = [];
    const slides: string[] = [];
    const client = new ProPresenterClient({
      host: "192.168.1.20",
      port: 1025,
      onSlideChange: (slide) => {
        if (slide) slides.push(slide.text);
      },
      onStatusChange: (status) => statuses.push(status),
    });

    client.connect(async () => ({
      text: "Welcome",
      notes: "",
      presentationName: "Service",
      slideIndex: 0,
      isScripture: false,
      receivedAt: Date.now(),
    }), 1025);
    await vi.waitFor(() => expect(slides).toEqual(["Welcome"]));

    expect(websocket).not.toHaveBeenCalled();
    expect(statuses).toContain("connected");
    expect(client.getDebugInfo().pollingActive).toBe(true);
    client.disconnect();
  });
});
