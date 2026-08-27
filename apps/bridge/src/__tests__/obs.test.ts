import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ObsConnection } from "../protocols/obs.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obsAuthentication(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

describe("OBS Bridge transport", () => {
  const servers: WebSocketServer[] = [];
  const connections: ObsConnection[] = [];

  afterEach(async () => {
    for (const connection of connections) connection.disconnect();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it("authenticates, refreshes live state, and correlates action responses", async () => {
    const password = "venue-secret";
    const salt = "test-salt";
    const challenge = "test-challenge";
    const requests: Record<string, unknown>[] = [];
    let identify: Record<string, unknown> | null = null;

    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt, challenge } } }));
      socket.on("message", (raw) => {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!isRecord(parsed) || !isRecord(parsed.d)) return;
        if (parsed.op === 1) {
          identify = parsed.d;
          socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
          return;
        }
        if (parsed.op !== 6 || typeof parsed.d.requestId !== "string" || typeof parsed.d.requestType !== "string") return;
        requests.push(parsed.d);
        const responseData = parsed.d.requestType === "GetCurrentProgramScene"
          ? { currentProgramSceneName: "Program" }
          : parsed.d.requestType === "GetCurrentPreviewScene"
            ? { currentPreviewSceneName: "Preview" }
            : parsed.d.requestType === "GetStreamStatus"
              ? { outputActive: true }
              : parsed.d.requestType === "GetRecordStatus"
                ? { outputActive: false }
                : parsed.d.requestType === "GetSceneList"
                  ? { scenes: [{ sceneName: "Program" }, { sceneName: "Preview" }] }
                  : parsed.d.requestType === "GetSceneItemId"
                    ? { sceneItemId: 42 }
                    : {};
        socket.send(JSON.stringify({
          op: 7,
          d: { requestId: parsed.d.requestId, requestStatus: { result: true }, responseData },
        }));
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected OBS test server address");
    const states: Array<Record<string, unknown>> = [];
    const disconnected = vi.fn();
    const connection = new ObsConnection();
    connections.push(connection);
    await connection.connect({
      host: "127.0.0.1",
      port: address.port,
      password,
      onState: (state) => states.push({ ...state }),
      onDisconnected: disconnected,
    });

    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(identify).toEqual(expect.objectContaining({
      rpcVersion: 1,
      authentication: obsAuthentication(password, salt, challenge),
    }));
    expect(states[0]).toEqual({
      currentProgramScene: "Program",
      currentPreviewScene: "Preview",
      streamingActive: true,
      recordingActive: false,
      scenes: ["Program", "Preview"],
    });

    await connection.executeAction("set_current_program_scene", { sceneName: "Wide" });
    await connection.executeAction("toggle_source_visibility", {
      sceneName: "Wide",
      sourceName: "Lower third",
      visible: true,
    });
    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestType: "SetCurrentProgramScene", requestData: { sceneName: "Wide" } }),
      expect.objectContaining({ requestType: "GetSceneItemId", requestData: { sceneName: "Wide", sourceName: "Lower third" } }),
      expect.objectContaining({ requestType: "SetSceneItemEnabled", requestData: { sceneName: "Wide", sceneItemId: 42, sceneItemEnabled: true } }),
    ]));

    connection.disconnect();
    await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
  });

  it("rejects failed OBS requests with the device response", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ op: 0, d: { rpcVersion: 1 } }));
      socket.on("message", (raw) => {
        const parsed: unknown = JSON.parse(raw.toString());
        if (!isRecord(parsed) || !isRecord(parsed.d)) return;
        if (parsed.op === 1) socket.send(JSON.stringify({ op: 2, d: {} }));
        if (parsed.op === 6 && typeof parsed.d.requestId === "string") {
          socket.send(JSON.stringify({ op: 7, d: {
            requestId: parsed.d.requestId,
            requestStatus: { result: false, comment: "Streaming is already active" },
          } }));
        }
      });
    });

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected OBS test server address");
    const connection = new ObsConnection();
    connections.push(connection);
    await connection.connect({
      host: "127.0.0.1",
      port: address.port,
      onState: () => {},
      onDisconnected: () => {},
    });
    await expect(connection.executeAction("start_streaming", {})).rejects.toThrow("Streaming is already active");
  });
});
