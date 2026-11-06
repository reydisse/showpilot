import { midiInputKey, parseControllerMessage, type MidiBinding, type MidiPortIdentity } from "./midi-controller";

function selectedPort<T extends MidiPortIdentity & { state: MIDIPortDeviceState }>(ports: T[], selected: MidiPortIdentity | null): T | null {
  if (!selected) return null;
  const exact = ports.find(port => port.id === selected.id);
  if (exact) return exact;
  const matches = selected.name ? ports.filter(port => port.name === selected.name && port.manufacturer === selected.manufacturer) : [];
  return matches.length === 1 ? matches[0] : null;
}
interface ControllerCallbacks {
  message: (input: MidiBinding["input"], value: number, previous: number | undefined) => void;
  ports: (inputs: MIDIInput[], outputs: MIDIOutput[], connected: boolean, feedbackConnected: boolean) => void;
  error: (message: string) => void;
}

/** Owns one controller listener. MTC and other consumers retain their listeners. */
export class MidiControllerRuntime {
  private input: MIDIInput | null = null;
  private output: MIDIOutput | null = null;
  private selectedInput: MidiPortIdentity | null = null;
  private selectedOutput: MidiPortIdentity | null = null;
  private values = new Map<string, number>();
  private desired = new Map<number, number[]>();
  private sent = new Map<number, string>();
  private timer: ReturnType<typeof setInterval>;
  private portsKey = "";
  private readonly onMessage = (event: MIDIMessageEvent) => {
    const parsed = parseControllerMessage(event.data);
    if (!parsed) return;
    const key = midiInputKey(parsed.input);
    const previous = this.values.get(key);
    this.values.set(key, parsed.value);
    // Releases reach the caller to establish edges, but repeated held notes do not fire.
    if (previous !== parsed.value || parsed.input.kind === "note" && parsed.value === 0) this.callbacks.message(parsed.input, parsed.value, previous);
  };
  constructor(private readonly access: MIDIAccess, private readonly callbacks: ControllerCallbacks) {
    access.addEventListener("statechange", this.scan);
    this.timer = setInterval(this.scan, 2_000);
    this.scan();
  }
  select(input: MidiPortIdentity | null, output: MidiPortIdentity | null): void {
    this.selectedInput = input; this.selectedOutput = output;
    this.scan();
  }
  resetInput(): void { this.values.clear(); }
  private readonly scan = () => {
    const inputs = [...this.access.inputs.values()].filter(port => port.state === "connected");
    const outputs = [...this.access.outputs.values()].filter(port => port.state === "connected");
    const input = selectedPort(inputs, this.selectedInput);
    const output = selectedPort(outputs, this.selectedOutput);
    const changed = input !== this.input || output !== this.output;
    if (input !== this.input) {
      this.input?.removeEventListener("midimessage", this.onMessage);
      this.input = input; this.values.clear();
      input?.addEventListener("midimessage", this.onMessage);
    }
    if (output !== this.output) {
      this.clearOutput(); this.output = output; this.sent.clear(); this.flush();
    }
    const key = JSON.stringify([inputs.map(port => port.id), outputs.map(port => port.id), Boolean(input), Boolean(output)]);
    if (key !== this.portsKey || changed) {
      this.portsKey = key;
      this.callbacks.ports(inputs, outputs, Boolean(input), Boolean(output));
    }
  };
  feedback(messages: number[][]): void {
    this.desired = new Map(messages.map(message => [message[1], message]));
    this.flush();
  }
  private flush(): void {
    if (!this.output) return;
    try {
      for (const note of this.sent.keys()) if (!this.desired.has(note)) {
        this.output.send([0x90, note, 0]); this.sent.delete(note);
      }
      for (const [note, message] of this.desired) {
        const key = message.join(",");
        if (this.sent.get(note) === key) continue;
        this.output.send(message); this.sent.set(note, key);
      }
    } catch { this.callbacks.error("Could not update controller lights. Check the MIDI output connection."); }
  }
  private clearOutput(): void {
    try { for (const note of this.sent.keys()) this.output?.send([0x90, note, 0]); }
    catch { /* A removed USB output cannot receive its final lights-off message. */ }
    this.sent.clear();
  }
  stop(): void {
    clearInterval(this.timer); this.access.removeEventListener("statechange", this.scan);
    this.input?.removeEventListener("midimessage", this.onMessage);
    this.clearOutput(); this.input = null; this.output = null; this.values.clear();
  }
}
