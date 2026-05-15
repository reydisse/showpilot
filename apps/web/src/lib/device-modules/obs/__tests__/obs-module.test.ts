import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OBSModule, obsModuleDefinition } from "../obs-module";

// ─── Mock WebSocket ───────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  // Test helpers
  simulateOpen() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateError() {
    this.onerror?.({ message: "Connection failed" });
  }

  simulateClose() {
    this.readyState = 3;
    this.onclose?.();
  }
}

// Replace global WebSocket
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  globalThis.WebSocket = OriginalWebSocket;
});

function getLastWS(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

// ─── Tests ────────────────────────────────────────────────

describe("OBSModule", () => {
  let module: OBSModule;

  beforeEach(() => {
    module = new OBSModule({ host: "192.168.1.100", port: 4455 });
  });

  afterEach(() => {
    module.disconnect();
  });

  describe("connection", () => {
    it("creates WebSocket to correct URL", async () => {
      const connectPromise = module.connect();
      const ws = getLastWS();
      expect(ws.url).toBe("ws://192.168.1.100:4455");

      // Simulate OBS handshake (no auth)
      ws.simulateOpen();
      ws.simulateMessage({
        op: 0, // Hello
        d: { obsWebSocketVersion: "5.0.0", rpcVersion: 1 },
      });
      // Simulate Identified
      ws.simulateMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });

      await connectPromise;
      expect(module.connectionStatus()).toBe("connected");
    });

    it("handles auth challenge when password is provided", async () => {
      module = new OBSModule({ host: "192.168.1.100", port: 4455, password: "secret" });
      const connectPromise = module.connect();
      const ws = getLastWS();

      ws.simulateOpen();
      ws.simulateMessage({
        op: 0,
        d: {
          obsWebSocketVersion: "5.0.0",
          rpcVersion: 1,
          authentication: { challenge: "abc123", salt: "def456" },
        },
      });

      // generateAuth is async — wait for it to process
      await vi.waitFor(() => {
        expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
      });

      const identify = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]);
      expect(identify.op).toBe(1); // Identify
      expect(identify.d.authentication).toBeDefined();

      ws.simulateMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
      await connectPromise;

      expect(module.connectionStatus()).toBe("connected");
    });

    it("transitions to error if WebSocket fails", async () => {
      const connectPromise = module.connect();
      const ws = getLastWS();

      ws.simulateError();
      ws.simulateClose();

      await connectPromise;
      expect(module.connectionStatus()).toBe("error");
    });

    it("transitions to disconnected on manual disconnect", async () => {
      const connectPromise = module.connect();
      const ws = getLastWS();
      ws.simulateOpen();
      ws.simulateMessage({ op: 0, d: { obsWebSocketVersion: "5.0.0", rpcVersion: 1 } });
      ws.simulateMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
      await connectPromise;

      module.disconnect();
      expect(module.connectionStatus()).toBe("disconnected");
    });

    it("uses default port 4455 when none specified", async () => {
      module = new OBSModule({ host: "10.0.0.5" });
      module.connect();
      const ws = getLastWS();
      expect(ws.url).toBe("ws://10.0.0.5:4455");
      ws.simulateClose();
    });
  });

  describe("actions", () => {
    it("returns all OBS actions", () => {
      const actions = module.getActions();
      expect(actions.length).toBeGreaterThan(0);

      const ids = actions.map((a) => a.id);
      expect(ids).toContain("set_current_program_scene");
      expect(ids).toContain("toggle_source_visibility");
      expect(ids).toContain("start_streaming");
      expect(ids).toContain("stop_streaming");
      expect(ids).toContain("start_recording");
      expect(ids).toContain("stop_recording");
    });

    it("sends correct WebSocket message for scene switch", async () => {
      // Connect first
      const connectPromise = module.connect();
      const ws = getLastWS();
      ws.simulateOpen();
      ws.simulateMessage({ op: 0, d: { obsWebSocketVersion: "5.0.0", rpcVersion: 1 } });
      ws.simulateMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
      await connectPromise;

      ws.sentMessages = []; // Clear handshake messages

      const actionPromise = module.executeAction("set_current_program_scene", {
        sceneName: "Main Camera",
      });

      // Simulate OBS responding to our request
      await vi.waitFor(() => {
        expect(ws.sentMessages).toHaveLength(1);
      });
      const msg = JSON.parse(ws.sentMessages[0]);
      expect(msg.op).toBe(6); // Request
      expect(msg.d.requestType).toBe("SetCurrentProgramScene");
      expect(msg.d.requestData.sceneName).toBe("Main Camera");

      // Send RequestResponse (op 7) to resolve the promise
      ws.simulateMessage({
        op: 7,
        d: { requestId: msg.d.requestId, requestStatus: { result: true } },
      });

      await actionPromise;
    });

    it("throws when executing action while disconnected", async () => {
      await expect(
        module.executeAction("start_streaming", {})
      ).rejects.toThrow("Not connected");
    });
  });

  describe("feedbacks", () => {
    it("returns feedback definitions", () => {
      const feedbacks = module.getFeedbacks();
      const ids = feedbacks.map((f) => f.id);
      expect(ids).toContain("current_program_scene");
      expect(ids).toContain("streaming_active");
      expect(ids).toContain("recording_active");
    });

    it("emits feedback on scene change event", async () => {
      const connectPromise = module.connect();
      const ws = getLastWS();
      ws.simulateOpen();
      ws.simulateMessage({ op: 0, d: { obsWebSocketVersion: "5.0.0", rpcVersion: 1 } });
      ws.simulateMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
      await connectPromise;

      const changes: [string, unknown][] = [];
      module.onFeedbackChange((id, val) => changes.push([id, val]));

      // OBS sends Event (op 5)
      ws.simulateMessage({
        op: 5,
        d: {
          eventType: "CurrentProgramSceneChanged",
          eventData: { sceneName: "Wide Shot" },
        },
      });

      expect(changes).toContainEqual(["current_program_scene", "Wide Shot"]);
    });

    it("emits feedback on streaming state change", async () => {
      const connectPromise = module.connect();
      const ws = getLastWS();
      ws.simulateOpen();
      ws.simulateMessage({ op: 0, d: { obsWebSocketVersion: "5.0.0", rpcVersion: 1 } });
      ws.simulateMessage({ op: 2, d: { negotiatedRpcVersion: 1 } });
      await connectPromise;

      const changes: [string, unknown][] = [];
      module.onFeedbackChange((id, val) => changes.push([id, val]));

      ws.simulateMessage({
        op: 5,
        d: {
          eventType: "StreamStateChanged",
          eventData: { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" },
        },
      });

      expect(changes).toContainEqual(["streaming_active", true]);
    });
  });

  describe("module definition", () => {
    it("has correct adapter type and category", () => {
      expect(obsModuleDefinition.adapterType).toBe("obs");
      expect(obsModuleDefinition.category).toBe("streaming");
      expect(obsModuleDefinition.connectivity).toBe("browser-direct");
      expect(obsModuleDefinition.transport).toBe("websocket");
    });

    it("has config fields for host, port, and password", () => {
      const keys = obsModuleDefinition.configFields.map((f) => f.key);
      expect(keys).toContain("host");
      expect(keys).toContain("port");
      expect(keys).toContain("password");
    });
  });
});
