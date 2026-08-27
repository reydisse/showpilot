import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback, ModuleDefinition } from "../types";
import { OBS_ACTIONS, OBS_FEEDBACKS, ACTION_TO_REQUEST } from "./obs-actions";
import { findAndNormalizeAction } from "../action-params";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * OBS Studio module — connects via obs-websocket v5 protocol.
 * Browser-direct WebSocket connection to OBS on the local network.
 *
 * Protocol reference: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 * OpCodes: 0=Hello, 1=Identify, 2=Identified, 5=Event, 6=Request, 7=RequestResponse
 */
export class OBSModule extends BaseDeviceModule {
  private ws: WebSocket | null = null;
  private host: string;
  private port: number;
  private password: string | undefined;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  >();
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(settings: Record<string, unknown>) {
    super();
    this.host = typeof settings.host === "string" ? settings.host.trim() : "";
    const port = Number(settings.port ?? 4455);
    this.port = Number.isInteger(port) ? port : 4455;
    this.password = typeof settings.password === "string" ? settings.password : undefined;
  }

  // ─── Connection ─────────────────────────────────────────

  protected async doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      const url = `ws://${this.host}:${this.port}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        // Wait for Hello message from OBS
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const parsed: unknown = JSON.parse(
            typeof event.data === "string" ? event.data : ""
          );
          if (isRecord(parsed) && typeof parsed.op === "number" && isRecord(parsed.d)) {
            this.handleMessage({ op: parsed.op, d: parsed.d });
          }
        } catch {
          // Ignore unparseable messages
        }
      };

      this.ws.onerror = () => {
        this.connectReject?.(new Error("WebSocket connection failed"));
        this.connectResolve = null;
        this.connectReject = null;
      };

      this.ws.onclose = () => {
        if (this.connectReject) {
          this.connectReject(new Error("WebSocket closed before connected"));
          this.connectResolve = null;
          this.connectReject = null;
        }
      };
    });
  }

  protected doDisconnect(): void {
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.pendingRequests.clear();
    this.connectResolve = null;
    this.connectReject = null;
  }

  // ─── OBS WebSocket v5 Protocol ──────────────────────────

  private handleMessage(msg: { op: number; d: Record<string, unknown> }) {
    switch (msg.op) {
      case 0: // Hello
        this.handleHello(msg.d);
        break;
      case 2: // Identified
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
        break;
      case 5: // Event
        this.handleEvent(msg.d);
        break;
      case 7: // RequestResponse
        this.handleRequestResponse(msg.d);
        break;
    }
  }

  private async handleHello(data: Record<string, unknown>) {
    const auth = isRecord(data.authentication)
      && typeof data.authentication.challenge === "string"
      && typeof data.authentication.salt === "string"
      ? { challenge: data.authentication.challenge, salt: data.authentication.salt }
      : undefined;

    const identifyData: Record<string, unknown> = {
      rpcVersion: 1,
      eventSubscriptions: 0xffff, // Subscribe to all events
    };

    if (auth && this.password) {
      identifyData.authentication = await this.generateAuth(
        this.password,
        auth.challenge,
        auth.salt
      );
    }

    this.send({ op: 1, d: identifyData }); // Identify
  }

  private handleEvent(data: Record<string, unknown>) {
    const eventType = typeof data.eventType === "string" ? data.eventType : "";
    const eventData = isRecord(data.eventData) ? data.eventData : null;
    if (!eventData) return;

    switch (eventType) {
      case "CurrentProgramSceneChanged":
        this.emitFeedback(
          "current_program_scene",
          eventData.sceneName ?? eventData.currentProgramSceneName
        );
        break;
      case "CurrentPreviewSceneChanged":
        this.emitFeedback(
          "current_preview_scene",
          eventData.sceneName ?? eventData.currentPreviewSceneName
        );
        break;
      case "StreamStateChanged":
        this.emitFeedback("streaming_active", eventData.outputActive);
        break;
      case "RecordStateChanged":
        this.emitFeedback("recording_active", eventData.outputActive);
        break;
      case "SceneListChanged":
        this.emitFeedback(
          "scene_list",
          JSON.stringify(eventData.scenes ?? [])
        );
        break;
    }
  }

  private handleRequestResponse(data: Record<string, unknown>) {
    const requestId = typeof data.requestId === "string" ? data.requestId : "";
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);
    const status = isRecord(data.requestStatus) ? data.requestStatus : null;

    if (status?.result === false) {
      pending.reject(new Error(typeof status.comment === "string" ? status.comment : `Request failed (code ${String(status.code ?? "unknown")})`));
    } else {
      pending.resolve(data.responseData ?? {});
    }
  }

  // ─── Auth ───────────────────────────────────────────────

  private async generateAuth(
    password: string,
    challenge: string,
    salt: string
  ): Promise<string> {
    const encoder = new TextEncoder();

    // Step 1: SHA256(password + salt) → base64
    const secret = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(password + salt)
    );
    const secretBase64 = btoa(
      String.fromCharCode(...new Uint8Array(secret))
    );

    // Step 2: SHA256(secretBase64 + challenge) → base64
    const auth = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(secretBase64 + challenge)
    );
    return btoa(String.fromCharCode(...new Uint8Array(auth)));
  }

  // ─── Transport ──────────────────────────────────────────

  private send(data: object) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private sendRequest(
    requestType: string,
    requestData: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `req_${++this.requestId}`;
      this.pendingRequests.set(id, { resolve, reject });
      this.send({
        op: 6, // Request
        d: { requestType, requestId: id, requestData },
      });
    });
  }

  // ─── DeviceModule interface ─────────────────────────────

  getActions(): ModuleAction[] {
    return OBS_ACTIONS;
  }

  async executeAction(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<void> {
    if (this.connectionStatus() !== "connected") {
      throw new Error("Not connected");
    }

    const { params: normalized } = findAndNormalizeAction(OBS_ACTIONS, actionId, params);
    if (actionId === "toggle_source_visibility") {
      const sceneItem = await this.sendRequest("GetSceneItemId", {
        sceneName: normalized.sceneName,
        sourceName: normalized.sourceName,
      });
      if (!sceneItem || typeof sceneItem !== "object" || !("sceneItemId" in sceneItem)) {
        throw new Error("OBS did not return the selected source.");
      }
      await this.sendRequest("SetSceneItemEnabled", {
        sceneName: normalized.sceneName,
        sceneItemId: sceneItem.sceneItemId,
        sceneItemEnabled: normalized.visible,
      });
      return;
    }

    const mapping = ACTION_TO_REQUEST[actionId];
    if (!mapping) {
      throw new Error(`Unknown action: ${actionId}`);
    }

    await this.sendRequest(mapping.requestType, mapping.mapParams(normalized));
  }

  getFeedbacks(): ModuleFeedback[] {
    return OBS_FEEDBACKS;
  }
}

// ─── Module Definition ────────────────────────────────────

export const obsModuleDefinition: ModuleDefinition = {
  adapterType: "obs",
  displayName: "OBS Studio",
  category: "streaming",
  transport: "websocket",
  connectivity: "browser-direct",
  configFields: [
    { key: "host", label: "Host / IP", placeholder: "192.168.1.100", required: true },
    { key: "port", label: "Port", placeholder: "4455", type: "number" },
    { key: "password", label: "Password", type: "password" },
  ],
  icon: "Monitor",
  description:
    "Control OBS Studio via obs-websocket v5. Switch scenes, toggle sources, control streaming and recording.",
  remoteControl: {
    protocol: "obs",
    target(settings) {
      const host = typeof settings.host === "string" ? settings.host.trim() : "";
      const port = Number(settings.port || 4455);
      return host && Number.isInteger(port) && port >= 1 && port <= 65_535 ? `${host}:${port}` : null;
    },
    actions: () => OBS_ACTIONS,
    feedbacks: () => OBS_FEEDBACKS,
    buildCommand(actionId, params) {
      const normalized = findAndNormalizeAction(OBS_ACTIONS, actionId, params);
      return JSON.stringify({ actionId: normalized.action.id, params: normalized.params });
    },
    parseEvent(eventName, data) {
      if (eventName !== "obs-state") return {};
      try {
        const state: unknown = JSON.parse(data);
        if (!isRecord(state)) return {};
        const values = state;
        return {
          ...(typeof values.currentProgramScene === "string" ? { current_program_scene: values.currentProgramScene } : {}),
          ...(typeof values.currentPreviewScene === "string" ? { current_preview_scene: values.currentPreviewScene } : {}),
          ...(typeof values.streamingActive === "boolean" ? { streaming_active: values.streamingActive } : {}),
          ...(typeof values.recordingActive === "boolean" ? { recording_active: values.recordingActive } : {}),
          ...(Array.isArray(values.scenes) ? { scene_list: JSON.stringify(values.scenes) } : {}),
        };
      } catch {
        return {};
      }
    },
  },
  createInstance: (settings) => new OBSModule(settings),
};
