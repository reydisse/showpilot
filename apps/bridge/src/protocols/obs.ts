import { createHash } from "node:crypto";
import WebSocket from "ws";

interface PendingRequest {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ObsState {
  currentProgramScene: string;
  currentPreviewScene: string;
  streamingActive: boolean;
  recordingActive: boolean;
  scenes: string[];
}

const REQUEST_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

export class ObsConnection {
  private ws: WebSocket | null = null;
  private requestNumber = 0;
  private pending = new Map<string, PendingRequest>();
  private state: ObsState = {
    currentProgramScene: "",
    currentPreviewScene: "",
    streamingActive: false,
    recordingActive: false,
    scenes: [],
  };

  async connect(input: {
    host: string;
    port: number;
    password?: string;
    onState(state: ObsState): void;
    onDisconnected(): void;
  }): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://${input.host}:${input.port}`);
      this.ws = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error("OBS connection timed out"));
      }, REQUEST_TIMEOUT_MS);

      socket.on("message", (raw) => {
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw.toString());
          if (!isRecord(parsed)) return;
          message = parsed;
        } catch {
          return;
        }
        const data = record(message.d);
        if (!data) return;
        if (message.op === 0) {
          const authentication = record(data.authentication);
          const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0xffff };
          if (authentication && input.password) {
            const challenge = requiredText(authentication.challenge, "OBS challenge");
            const salt = requiredText(authentication.salt, "OBS salt");
            const secret = createHash("sha256").update(input.password + salt).digest("base64");
            identify.authentication = createHash("sha256").update(secret + challenge).digest("base64");
          }
          socket.send(JSON.stringify({ op: 1, d: identify }));
          return;
        }
        if (message.op === 2) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          void this.refreshState(input.onState);
          return;
        }
        if (message.op === 5) {
          this.applyEvent(data, input.onState);
          return;
        }
        if (message.op === 7) this.resolveRequest(data);
      });

      socket.once("error", (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.once("close", () => {
        clearTimeout(timer);
        this.rejectPending("OBS disconnected");
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error("OBS disconnected before authentication completed"));
        } else {
          input.onDisconnected();
        }
      });
    });
  }

  disconnect(): void {
    const socket = this.ws;
    this.ws = null;
    socket?.close();
    this.rejectPending("OBS disconnected");
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async executeAction(actionId: string, params: Record<string, unknown>): Promise<void> {
    switch (actionId) {
      case "set_current_program_scene":
        await this.request("SetCurrentProgramScene", { sceneName: requiredText(params.sceneName, "Scene name") });
        return;
      case "set_current_preview_scene":
        await this.request("SetCurrentPreviewScene", { sceneName: requiredText(params.sceneName, "Scene name") });
        return;
      case "toggle_source_visibility": {
        const sceneName = requiredText(params.sceneName, "Scene name");
        const sourceName = requiredText(params.sourceName, "Source name");
        if (typeof params.visible !== "boolean") throw new Error("Visible must be on or off");
        const item = await this.request("GetSceneItemId", { sceneName, sourceName });
        if (typeof item.sceneItemId !== "number") throw new Error("OBS source was not found in the selected scene");
        await this.request("SetSceneItemEnabled", { sceneName, sceneItemId: item.sceneItemId, sceneItemEnabled: params.visible });
        return;
      }
      case "start_streaming": await this.request("StartStream", {}); return;
      case "stop_streaming": await this.request("StopStream", {}); return;
      case "start_recording": await this.request("StartRecord", {}); return;
      case "stop_recording": await this.request("StopRecord", {}); return;
      case "set_source_volume": {
        const inputName = requiredText(params.inputName, "Input name");
        const volumeDb = Number(params.volumeDb);
        if (!Number.isFinite(volumeDb) || volumeDb < -100 || volumeDb > 26) throw new Error("Volume must be between -100 and 26 dB");
        await this.request("SetInputVolume", { inputName, inputVolumeDb: volumeDb });
        return;
      }
      case "toggle_input_mute":
        await this.request("ToggleInputMute", { inputName: requiredText(params.inputName, "Input name") });
        return;
      default:
        throw new Error(`Unknown OBS action: ${actionId}`);
    }
  }

  private request(requestType: string, requestData: Record<string, unknown>): Promise<Record<string, unknown>> {
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("OBS is not connected"));
    const requestId = `obs-${++this.requestNumber}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS ${requestType} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  private resolveRequest(data: Record<string, unknown>): void {
    if (typeof data.requestId !== "string") return;
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(data.requestId);
    const status = record(data.requestStatus);
    if (status?.result === false) {
      pending.reject(new Error(typeof status.comment === "string" ? status.comment : "OBS request failed"));
      return;
    }
    pending.resolve(record(data.responseData) ?? {});
  }

  private async refreshState(onState: (state: ObsState) => void): Promise<void> {
    const results = await Promise.allSettled([
      this.request("GetCurrentProgramScene", {}),
      this.request("GetCurrentPreviewScene", {}),
      this.request("GetStreamStatus", {}),
      this.request("GetRecordStatus", {}),
      this.request("GetSceneList", {}),
    ]);
    const value = (index: number) => results[index]?.status === "fulfilled" ? results[index].value : {};
    const program = value(0);
    const preview = value(1);
    const stream = value(2);
    const recordStatus = value(3);
    const sceneList = value(4);
    this.state = {
      currentProgramScene: typeof program.currentProgramSceneName === "string" ? program.currentProgramSceneName : this.state.currentProgramScene,
      currentPreviewScene: typeof preview.currentPreviewSceneName === "string" ? preview.currentPreviewSceneName : this.state.currentPreviewScene,
      streamingActive: typeof stream.outputActive === "boolean" ? stream.outputActive : this.state.streamingActive,
      recordingActive: typeof recordStatus.outputActive === "boolean" ? recordStatus.outputActive : this.state.recordingActive,
      scenes: Array.isArray(sceneList.scenes)
        ? sceneList.scenes.flatMap((scene) => {
            const item = record(scene);
            return typeof item?.sceneName === "string" ? [item.sceneName] : [];
          })
        : this.state.scenes,
    };
    onState(this.state);
  }

  private applyEvent(data: Record<string, unknown>, onState: (state: ObsState) => void): void {
    const eventType = typeof data.eventType === "string" ? data.eventType : "";
    const eventData = record(data.eventData) ?? {};
    switch (eventType) {
      case "CurrentProgramSceneChanged":
        if (typeof eventData.sceneName === "string") this.state.currentProgramScene = eventData.sceneName;
        break;
      case "CurrentPreviewSceneChanged":
        if (typeof eventData.sceneName === "string") this.state.currentPreviewScene = eventData.sceneName;
        break;
      case "StreamStateChanged":
        if (typeof eventData.outputActive === "boolean") this.state.streamingActive = eventData.outputActive;
        break;
      case "RecordStateChanged":
        if (typeof eventData.outputActive === "boolean") this.state.recordingActive = eventData.outputActive;
        break;
      case "SceneListChanged":
        if (Array.isArray(eventData.scenes)) {
          this.state.scenes = eventData.scenes.flatMap((scene) => {
            const item = record(scene);
            return typeof item?.sceneName === "string" ? [item.sceneName] : [];
          });
        }
        break;
      default:
        return;
    }
    onState(this.state);
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}
