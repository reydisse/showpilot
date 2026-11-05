import { z } from "zod";
import { BaseDeviceModule } from "./device-modules/base-module";
import { getSharedBridgeProxy } from "./device-modules/bridge-proxy";
import type { ModuleAction, ModuleFeedback, RemoteControlDefinition } from "./device-modules/types";

const stateSchema = z.object({
  connected: z.boolean(),
  bridgeOnline: z.boolean(),
  controls: z.array(z.object({
    id: z.string(), label: z.string(), category: z.string(),
    params: z.array(z.object({
      id: z.string(), label: z.string(), type: z.enum(["number", "string", "boolean", "select"]),
      options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
      min: z.number().optional(), max: z.number().optional(), step: z.number().optional(), default: z.unknown().optional(),
    })),
  })),
  feedbacks: z.array(z.object({
    id: z.string(), label: z.string(), type: z.enum(["boolean", "number", "string", "enum"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]), available: z.boolean(),
  })),
});

/** Saved credentials stay on the server. The browser addresses a device by ID;
 * the server authorizes each operation and resolves its current saved settings. */
export class StoredDeviceModule extends BaseDeviceModule {
  private readonly url: string;
  private actions: ModuleAction[];
  private feedbacks: ModuleFeedback[];
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void)[] = [];
  private refreshGeneration = 0;
  private disconnectAttempt: Promise<unknown> | null = null;

  constructor(private readonly orgId: string, deviceId: string,
    private readonly remote: RemoteControlDefinition, private readonly settings: Record<string, unknown>) {
    super();
    this.url = `/api/mobile/v1/devices/${encodeURIComponent(deviceId)}/control?orgId=${encodeURIComponent(orgId)}`;
    this.actions = remote.actions(settings);
    this.feedbacks = remote.feedbacks(settings);
  }

  private async request(body: Record<string, unknown> | undefined, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(this.url, {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(value);
      throw new Error(failure.success ? failure.data.error : "Device request failed. Try again.");
    }
    if (body && !z.object({ success: z.literal(true) }).safeParse(value).success) throw new Error("Device did not confirm the operation.");
    return value;
  }

  private values(values: Record<string, unknown>): void {
    this.feedbacks = this.feedbacks.map(feedback => Object.hasOwn(values, feedback.id) ? { ...feedback, value: values[feedback.id] } : feedback);
    for (const [id, value] of Object.entries(values)) this.emitFeedback(id, value);
  }

  private async refresh(controller: AbortController): Promise<void> {
    if (controller.signal.aborted) return;
    const generation = ++this.refreshGeneration;
    const state = stateSchema.parse(await this.request(undefined, controller.signal));
    if (controller !== this.controller || controller.signal.aborted || generation !== this.refreshGeneration) return;
    this.actions = state.controls;
    this.feedbacks = state.feedbacks;
    this.values(Object.fromEntries(state.feedbacks.map(feedback => [feedback.id, feedback.available ? feedback.value : null])));
    this.setStatus(!state.bridgeOnline ? "bridge-required" : state.connected ? "connected" : "disconnected");
  }

  private schedule(controller: AbortController): void {
    if (controller !== this.controller || controller.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (document.visibilityState === "hidden") { this.schedule(controller); return; }
      void this.refresh(controller).catch(error => {
        if (controller === this.controller && !controller.signal.aborted) this.setStatus("error", error instanceof Error ? error.message : "Device status unavailable.");
      }).finally(() => this.schedule(controller));
    }, 2000);
  }

  protected async doConnect(): Promise<void> {
    this.doDisconnect();
    const controller = new AbortController();
    this.controller = controller;
    const target = this.remote.target(this.settings);
    const proxy = getSharedBridgeProxy(this.orgId);
    this.unsubscribe = [
      proxy.onDeviceStatus((address, connected) => {
        if (address === target && !controller.signal.aborted) this.setStatus(connected ? "connected" : "disconnected");
      }),
      proxy.onDeviceEvent((address, eventName, data) => {
        if (address === target && !controller.signal.aborted && this.remote.parseEvent) this.values(this.remote.parseEvent(eventName, data, this.settings));
      }),
    ];
    try {
      if (this.disconnectAttempt) await this.disconnectAttempt;
      if (controller.signal.aborted) return;
      await this.request({ operation: "connect" }, controller.signal);
      await this.refresh(controller);
      if (controller.signal.aborted) return;
      if (this.connectionStatus() !== "connected") throw new Error("The venue Bridge has not confirmed this device is connected.");
      this.schedule(controller);
    } catch (error) {
      this.doDisconnect();
      throw error;
    }
  }

  /** Unmounting a control panel detaches its listeners, never a shared venue device. */
  override disconnect(): void {
    // A status event can already say "disconnected" while polling is still active.
    this.doDisconnect();
    super.disconnect();
  }

  protected doDisconnect(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribe.forEach(unsubscribe => unsubscribe());
    this.unsubscribe = [];
  }

  /** Only an explicit operator action stops the physical connection. */
  async disconnectDevice(): Promise<void> {
    this.disconnect();
    const attempt = this.request({ operation: "disconnect" }, AbortSignal.timeout(15_000));
    this.disconnectAttempt = attempt;
    try { await attempt; }
    finally { if (this.disconnectAttempt === attempt) this.disconnectAttempt = null; }
  }

  getActions(): ModuleAction[] { return this.actions; }
  getFeedbacks(): ModuleFeedback[] { return this.feedbacks; }
  async executeAction(actionId: string, params: Record<string, unknown>): Promise<void> {
    const controller = this.controller;
    if (!controller || this.connectionStatus() !== "connected") throw new Error("Connect this device before sending commands.");
    await this.request({ operation: "action", actionId, params }, controller.signal);
    // Event feedback arrives immediately; queries cover protocols without events.
    await this.refresh(controller);
  }
}
