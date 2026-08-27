import { describe, expect, it } from "vitest";
import {
  bridgeWebSocketOptions,
  connectedBridgeTargets,
  isSupportedConnectProtocol,
} from "../bridge.js";

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

  it("rejects device protocols the Bridge cannot connect", () => {
    expect(isSupportedConnectProtocol("atem")).toBe(true);
    expect(isSupportedConnectProtocol("propresenter")).toBe(true);
    expect(isSupportedConnectProtocol("made-up-protocol")).toBe(false);
  });

  it("reports every unique connected target, including stateless HTTP adapters", () => {
    expect(connectedBridgeTargets(
      ["10.0.0.3:9910", "10.0.0.2:4455"],
      ["10.0.0.3:9910"],
      ["10.0.0.4:80"],
    )).toEqual(["10.0.0.2:4455", "10.0.0.3:9910", "10.0.0.4:80"]);
  });
});
