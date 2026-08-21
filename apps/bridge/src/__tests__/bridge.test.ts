import { describe, expect, it } from "vitest";
import { bridgeWebSocketOptions } from "../bridge.js";

describe("bridge WebSocket authentication", () => {
  it("sends the Bridge key in the API header used by production", () => {
    const connection = bridgeWebSocketOptions(
      "wss://showpilot.tech/api/bridge/faithfire-production/ws",
      "sp_test_secret",
    );

    expect(connection.url).toBe(
      "wss://showpilot.tech/api/bridge/faithfire-production/ws?role=bridge",
    );
    expect(connection.options?.headers).toEqual({
      "x-showpilot-api-key": "sp_test_secret",
    });
    expect(connection.url).not.toContain("sp_test_secret");
  });

  it("removes stale query-string keys", () => {
    const connection = bridgeWebSocketOptions(
      "wss://showpilot.tech/api/bridge/org/ws?key=old&role=client",
    );

    expect(connection.url).toBe(
      "wss://showpilot.tech/api/bridge/org/ws?role=bridge",
    );
    expect(connection.options).toBeUndefined();
  });
});
