import { BaseDeviceModule } from "../base-module";
import type { ModuleAction, ModuleFeedback } from "../types";
import type { ProtocolDriver } from "../protocols/protocol-driver";
import type {
  DeviceProfile,
  ProfileAction,
  ProfileFeedback,
  ParamTransform,
} from "./types";

/**
 * A DeviceModule driven entirely by a JSON DeviceProfile + ProtocolDriver.
 * Handles command interpolation, param transforms, command queue, and feedback polling.
 */
export class ProfileDrivenModule extends BaseDeviceModule {
  private profile: DeviceProfile;
  private driver: ProtocolDriver;
  private commandQueue: Array<{ command: string; resolve: () => void; reject: (e: Error) => void }> = [];
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimers: ReturnType<typeof setInterval>[] = [];

  constructor(profile: DeviceProfile, driver: ProtocolDriver) {
    super();
    this.profile = profile;
    this.driver = driver;
  }

  // ─── Connection ─────────────────────────────────────────

  protected async doConnect(): Promise<void> {
    await this.driver.connect({});

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

    const profileAction = this.profile.actions.find((a) => a.id === actionId);
    if (!profileAction) {
      throw new Error(`Unknown action: ${actionId}`);
    }

    const command = this.interpolateCommand(profileAction, params);
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

  private interpolateCommand(
    action: ProfileAction,
    params: Record<string, unknown>
  ): string {
    let command = action.mapping.command;
    const transforms = action.mapping.paramTransforms;

    // Replace each {{paramName}} with the (optionally transformed) value
    command = command.replace(/\{\{(\w+)\}\}/g, (_match, paramName: string) => {
      let value = params[paramName];

      // Apply transform if defined
      if (transforms?.[paramName]) {
        value = this.applyTransform(value, transforms[paramName]);
      }

      return String(value ?? "");
    });

    return command;
  }

  private applyTransform(value: unknown, transform: ParamTransform): unknown {
    switch (transform.type) {
      case "map":
        return transform.values?.[String(value)] ?? String(value);

      case "scale":
        return Number(value) * (transform.factor ?? 1);

      case "format": {
        // Simple format support: %02X (hex), %03d (zero-padded decimal)
        const fmt = transform.format ?? "%s";
        const num = Number(value);
        if (fmt.includes("X") || fmt.includes("x")) {
          return num.toString(16).toUpperCase().padStart(2, "0");
        }
        if (fmt.includes("d")) {
          const padMatch = fmt.match(/(\d+)/);
          const pad = padMatch ? parseInt(padMatch[1]) : 0;
          return String(Math.round(num)).padStart(pad, "0");
        }
        return String(value);
      }

      default:
        return value;
    }
  }

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

      const value = this.parseFeedbackResponse(response, feedback);
      if (value !== undefined) {
        this.emitFeedback(feedback.id, value);
      }
    } catch {
      // Polling failures are silent — don't break the module
    }
  }

  private parseFeedbackResponse(
    response: string,
    feedback: ProfileFeedback
  ): unknown {
    const { responsePattern, captureGroup, valueMap } = feedback.mapping;
    if (!responsePattern) return response;

    const regex = new RegExp(responsePattern);
    const match = response.match(regex);
    if (!match) return undefined;

    const rawValue = match[captureGroup ?? 1] ?? match[0];

    // Apply value map if present
    if (valueMap) {
      return valueMap[rawValue] ?? rawValue;
    }

    return rawValue;
  }
}
