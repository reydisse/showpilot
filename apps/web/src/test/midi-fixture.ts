/** Synthetic Web MIDI boundary. No claim of physical USB or browser permissions. */
export class MidiInputFixture extends EventTarget {
  readonly manufacturer = "ShowPilot fixture";
  state: MIDIPortDeviceState = "connected";
  constructor(readonly id: string, readonly name = id) { super(); }
  send(bytes: number[]) {
    const event = new Event("midimessage");
    Object.defineProperty(event, "data", { value: Uint8Array.from(bytes) });
    this.dispatchEvent(event);
  }
}

export class MidiAccessFixture extends EventTarget {
  readonly inputs = new Map<string, MidiInputFixture>();
  readonly outputs = new Map<string, MidiOutputFixture>();
  readonly sysexEnabled = false;
  constructor(...inputs: MidiInputFixture[]) {
    super();
    inputs.forEach(input => this.inputs.set(input.id, input));
  }
  connect(input: MidiInputFixture, notify = true) {
    input.state = "connected";
    this.inputs.set(input.id, input);
    if (notify) this.dispatchEvent(new Event("statechange"));
  }
  disconnect(input: MidiInputFixture, notify = true) {
    input.state = "disconnected";
    this.inputs.delete(input.id);
    if (notify) this.dispatchEvent(new Event("statechange"));
  }
}

export class MidiOutputFixture extends EventTarget {
  readonly manufacturer = "ShowPilot fixture";
  state: MIDIPortDeviceState = "connected";
  readonly messages: number[][] = [];
  constructor(readonly id: string, readonly name = id) { super(); }
  send(bytes: number[]) { this.messages.push([...bytes]); }
}
