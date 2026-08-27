import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback } from "../types";
import type { ProtocolDriver } from "../protocols/protocol-driver";
import type {
  DeviceProfile,
  ProfileFeedback,
  ParamTransform,
} from "./types";
import { normalizeActionParams } from "../action-params";

function applyProfileTransform(value: unknown, transform: ParamTransform): unknown {
  switch (transform.type) {
    case "map":
      return transform.values?.[String(value)] ?? String(value);
    case "scale":
      return Number(value) * (transform.factor ?? 1);
    case "format": {
      const format = transform.format ?? "%s";
      const number = Number(value);
      if (format.includes("X") || format.includes("x")) {
        return number.toString(16).toUpperCase().padStart(2, "0");
      }
      if (format.includes("d")) {
        const padding = format.match(/(\d+)/)?.[1];
        return String(Math.round(number)).padStart(padding ? Number.parseInt(padding, 10) : 0, "0");
      }
      return String(value);
    }
    default: {
      const exhaustive: never = transform.type;
      return exhaustive;
    }
  }
}

export function buildProfileCommand(
  profile: DeviceProfile,
  actionId: string,
  input: Record<string, unknown>,
): string {
  const action = profile.actions.find((candidate) => candidate.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);
  const params = normalizeActionParams(action, input);
  const transforms = action.mapping.paramTransforms;
  return action.mapping.command.replace(/\{\{(\w+)\}\}/g, (_match, paramName: string) => {
    const value = transforms?.[paramName]
      ? applyProfileTransform(params[paramName], transforms[paramName])
      : params[paramName];
    return String(value ?? "");
  });
}

export function parseProfileFeedback(response: string, feedback: ProfileFeedback): unknown {
  const { responsePattern, captureGroup, valueMap } = feedback.mapping;
  if (!responsePattern) return response;
  const match = response.match(new RegExp(responsePattern));
  if (!match) return undefined;
  const rawValue = match[captureGroup ?? 1] ?? match[0];
  if (valueMap) return valueMap[rawValue] ?? rawValue;
  if (feedback.type === "number") {
    const number = Number(rawValue);
    return Number.isFinite(number) ? number : undefined;
  }
  if (feedback.type === "boolean") return rawValue === "1" || rawValue.toLowerCase() === "true";
  return rawValue;
}

/**
 * A DeviceModule driven entirely by a JSON DeviceProfile + ProtocolDriver.
 * Handles command interpolation, param transforms, command queue, and feedback polling.
 */
export class ProfileDrivenModule extends BaseDeviceModule {
  private profile: DeviceProfile;
  private driver: ProtocolDriver;
  private settings: Record<string, unknown>;
  private commandQueue: Array<{ command: string; resolve: () => void; reject: (e: Error) => void }> = [];
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimers: ReturnType<typeof setInterval>[] = [];

  constructor(profile: DeviceProfile, driver: ProtocolDriver, settings: Record<string, unknown>) {
    super();
    this.profile = profile;
    this.driver = driver;
    this.settings = settings;
  }

  // ─── Connection ─────────────────────────────────────────

  protected async doConnect(): Promise<void> {
    await this.driver.connect(this.settings);

    // Apply connectDelay quirk
    const delay = this.profile.quirks?.connectDelay;
    if (delay && delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    // Start feedback polling
    this.startPolling();
  }

  protected doDisconnect(): void {
    this.stopPolling();
    this.clearCommandQueue();
    this.driver.disconnect();
  }

  // ─── Actions ────────────────────────────────────────────

  getActions(): ModuleAction[] {
    return this.profile.actions.map((a) => ({
      id: a.id,
      label: a.label,
      category: a.category,
      params: a.params,
    }));
  }

  async executeAction(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<void> {
    if (this.connectionStatus() !== "connected") {
      throw new Error("Not connected");
    }

    const command = buildProfileCommand(this.profile, actionId, params);
    await this.enqueueCommand(command);
  }

  // ─── Feedbacks ──────────────────────────────────────────

  getFeedbacks(): ModuleFeedback[] {
    return this.profile.feedbacks.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      value: f.defaultValue,
    }));
  }

  // ─── Command Interpolation ──────────────────────────────

  // ─── Command Queue ──────────────────────────────────────

  private enqueueCommand(command: string): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.commandQueue.push({ command, resolve, reject });
      if (!this.draining) {
        this.drainQueue();
      }
    });
    // Prevent unhandled rejection on disconnect while commands are pending
    promise.catch(() => {});
    return promise;
  }

  private drainQueue(): void {
    if (this.commandQueue.length === 0) {
      this.draining = false;
      return;
    }

    this.draining = true;
    const item = this.commandQueue.shift()!;

    this.driver
      .sendCommand(item.command)
      .then(() => item.resolve())
      .catch((err) => item.reject(err instanceof Error ? err : new Error(String(err))))
      .finally(() => {
        const interval = this.profile.quirks?.commandInterval ?? 0;
        if (interval > 0 && this.commandQueue.length > 0) {
          this.drainTimer = setTimeout(() => this.drainQueue(), interval);
        } else {
          this.drainQueue();
        }
      });
  }

  private clearCommandQueue(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const item of this.commandQueue) {
      item.reject(new Error("Disconnected"));
    }
    this.commandQueue = [];
    this.draining = false;
  }

  // ─── Feedback Polling ───────────────────────────────────

  private startPolling(): void {
    for (const feedback of this.profile.feedbacks) {
      if (!feedback.mapping.pollCommand) continue;

      const interval = feedback.mapping.pollInterval ?? 5000;
      const timer = setInterval(() => {
        this.pollFeedback(feedback);
      }, interval);
      this.pollTimers.push(timer);
    }
  }

  private stopPolling(): void {
    for (const timer of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers = [];
  }

  private async pollFeedback(feedback: ProfileFeedback): Promise<void> {
    if (this.connectionStatus() !== "connected") return;

    try {
      const response = await this.driver.sendCommand(feedback.mapping.pollCommand!);
      if (!response) return;

      const value = parseProfileFeedback(response, feedback);
      if (value !== undefined) {
        this.emitFeedback(feedback.id, value);
      }
    } catch {
      // Polling failures are silent — don't break the module
    }
  }

}
