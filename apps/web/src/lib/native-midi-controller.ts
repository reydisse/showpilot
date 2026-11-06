import { Channel, invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { createBrowserId } from "./browser-id";
import { midiPortSchema, type MidiPortIdentity } from "./midi-controller";
import { ControllerInputState, type ControllerCallbacks, type ControllerRuntime } from "./midi-controller-runtime";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const statusSchema = z.object({
  sessionId: z.string(), revision: counter, generation: counter,
  inputs: z.array(midiPortSchema), outputs: z.array(midiPortSchema),
  inputConnected: z.boolean(), outputConnected: z.boolean(), error: z.string().nullable(),
}).strict();
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ports"), status: statusSchema }).strict(),
  z.object({ type: z.literal("message"), sessionId: z.string(), generation: counter, data: z.array(z.number().int().min(0).max(255)).length(3) }).strict(),
]);
type Status = z.infer<typeof statusSchema>;

/** Local IPC only. Session and selection revisions reject stale webview work. */
export class NativeMidiControllerRuntime implements ControllerRuntime {
  private readonly sessionId = createBrowserId();
  private readonly channel = new Channel<unknown>();
  private readonly inputState: ControllerInputState;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private refreshing = false;
  private revision = 0;
  private selectionKey = "";
  private portsKey = "";
  private status: Status | null = null;
  private desired: number[][] = [];
  private feedbackDirty = false;
  private sending = false;

  private constructor(private readonly callbacks: ControllerCallbacks) {
    this.inputState = new ControllerInputState(callbacks.message);
    this.channel.onmessage = raw => {
      if (this.stopped) return;
      const event = eventSchema.safeParse(raw);
      if (!event.success) { this.fail("Invalid response from the native MIDI engine. Reconnect the controller."); return; }
      if (event.data.type === "ports") this.accept(event.data.status);
      else if (event.data.sessionId === this.sessionId && this.status?.revision === this.revision && this.status.inputConnected && event.data.generation === this.status.generation) {
        this.inputState.receive(new Uint8Array(event.data.data));
      }
    };
  }

  static async connect(callbacks: ControllerCallbacks): Promise<NativeMidiControllerRuntime> {
    const runtime = new NativeMidiControllerRuntime(callbacks);
    try {
      runtime.accept(await runtime.call("open", { channel: runtime.channel }));
      if (runtime.stopped) throw new Error("Native MIDI session closed while connecting.");
      runtime.timer = setInterval(() => void runtime.refresh(), 2_000);
      return runtime;
    } catch (cause) { runtime.stop(); throw cause; }
  }

  private async call(command: string, args: Record<string, unknown> = {}): Promise<Status> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        invoke<unknown>(`midi_controller_${command}`, { sessionId: this.sessionId, ...args }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Native MIDI engine did not respond. Reconnect the controller.")), 7_000); }),
      ]);
      const status = statusSchema.parse(raw);
      if (status.sessionId !== this.sessionId) throw new Error("Native MIDI session changed. Reconnect the controller.");
      return status;
    } finally { clearTimeout(timeout); }
  }

  private accept(status: Status): void {
    if (this.stopped || status.sessionId !== this.sessionId || status.revision !== this.revision || status.generation < (this.status?.generation ?? 0)) return;
    if (status.generation !== this.status?.generation) this.resetInput();
    this.status = status;
    const key = JSON.stringify(status);
    if (key !== this.portsKey) {
      this.portsKey = key;
      this.callbacks.ports(status.inputs, status.outputs, status.inputConnected, status.outputConnected);
      if (status.error) this.callbacks.error(status.error);
    }
  }

  select(input: MidiPortIdentity | null, output: MidiPortIdentity | null): void {
    const key = JSON.stringify([input, output]);
    if (this.stopped || key === this.selectionKey) return;
    this.selectionKey = key;
    const revision = ++this.revision;
    this.resetInput();
    // Until the selected connection is acknowledged, no old input may execute a cue.
    this.callbacks.ports(this.status?.inputs ?? [], this.status?.outputs ?? [], false, false);
    void this.call("select", { revision, input, output }).then(status => {
      this.accept(status);
      if (revision === this.revision) { this.feedbackDirty = true; void this.flush(); }
    }).catch(cause => this.fail(cause));
  }

  resetInput(): void { this.inputState.clear(); }

  feedback(messages: number[][]): void {
    if (this.stopped) return;
    if (JSON.stringify(messages) === JSON.stringify(this.desired)) return;
    this.desired = messages.map(message => [...message]);
    this.feedbackDirty = true;
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || this.stopped || this.status?.revision !== this.revision) return;
    this.sending = true;
    try {
      while (this.feedbackDirty && !this.stopped && this.status?.revision === this.revision) {
        this.feedbackDirty = false;
        this.accept(await this.call("feedback", { revision: this.revision, messages: this.desired }));
      }
    } catch (cause) { this.fail(cause); }
    finally { this.sending = false; }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try { this.accept(await this.call("refresh")); }
    catch (cause) { this.fail(cause); }
    finally { this.refreshing = false; }
  }

  private fail(cause: unknown): void {
    if (this.stopped) return;
    this.stop();
    this.callbacks.error(cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Native MIDI engine unavailable. Reconnect the controller.");
    this.callbacks.closed?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.resetInput();
    // The backend also expires abandoned sessions if the webview cannot send this.
    void invoke("midi_controller_close", { sessionId: this.sessionId }).catch(() => {});
  }
}
