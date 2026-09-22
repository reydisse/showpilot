import type { TimecodeValue, TimecodeFormat } from "@/types/timecode";

/**
 * MTC (MIDI Timecode) source via Web MIDI API.
 * Decodes quarter-frame messages to reconstruct SMPTE timecode.
 *
 * MTC encodes timecode across 8 quarter-frame messages (F1 xx):
 *   0: frames low nibble
 *   1: frames high nibble
 *   2: seconds low nibble
 *   3: seconds high nibble
 *   4: minutes low nibble
 *   5: minutes high nibble
 *   6: hours low nibble
 *   7: hours high nibble + frame rate (bits 5-6)
 *
 * A complete timecode is reconstructed after all 8 nibbles are received.
 * At 30fps, that means ~2 frames of latency (8 quarter-frames / 4 per frame).
 */

interface MtcAccumulator {
  nibbles: number[];
  seenMask: number;
  lastType: number | null;
  direction: 1 | -1 | null;
}

export interface MtcSourceCallback {
  (tc: TimecodeValue, format: TimecodeFormat): void;
}

export class MtcSource {
  private midiAccess: MIDIAccess | null = null;
  private input: MIDIInput | null = null;
  private accumulator = this.emptyAccumulator();
  private onTimecode: MtcSourceCallback;

  constructor(callback: MtcSourceCallback) {
    this.onTimecode = callback;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
  }

  static async getInputs(): Promise<MIDIInput[]> {
    if (!MtcSource.isSupported()) return [];
    // Quarter-frame MTC is a normal MIDI system-common message and does not
    // require privileged SysEx access. Asking for SysEx caused browsers and
    // managed devices to reject the entire MIDI permission request.
    const access = await navigator.requestMIDIAccess();
    return [...access.inputs.values()];
  }

  async start(inputId: string): Promise<void> {
    if (!MtcSource.isSupported()) {
      throw new Error("Web MIDI API not supported in this browser");
    }

    this.midiAccess = await navigator.requestMIDIAccess();
    this.input = this.midiAccess.inputs.get(inputId) ?? null;

    if (!this.input) {
      throw new Error(`MIDI input "${inputId}" not found`);
    }

    this.input.onmidimessage = this.handleMidiMessage.bind(this);
  }

  stop(): void {
    if (this.input) {
      this.input.onmidimessage = null;
    }
    this.input = null;
    this.midiAccess = null;
    this.accumulator = this.emptyAccumulator();
  }

  private handleMidiMessage(event: MIDIMessageEvent): void {
    const data = event.data;
    if (!data || data.length === 0) return;

    // Quarter-frame: status byte 0xF1
    if (data[0] === 0xf1 && data.length >= 2) {
      this.handleQuarterFrame(data[1]);
      return;
    }

    // Full-frame SysEx: F0 7F 7F 01 01 hr mn sc fr F7
    if (
      data[0] === 0xf0 &&
      data.length >= 10 &&
      data[1] === 0x7f &&
      data[3] === 0x01 &&
      data[4] === 0x01
    ) {
      this.handleFullFrame(data);
    }
  }

  private handleQuarterFrame(dataByte: number): void {
    const messageType = (dataByte >> 4) & 0x07; // bits 4-6
    const nibbleValue = dataByte & 0x0f; // bits 0-3

    const previousType = this.accumulator.lastType;
    if (previousType === null) {
      this.beginSequence(messageType, nibbleValue);
      return;
    }

    const forward = (previousType + 1) % 8;
    const reverse = (previousType + 7) % 8;
    const nextDirection = messageType === forward ? 1 : messageType === reverse ? -1 : null;
    if (
      nextDirection === null
      || (this.accumulator.direction !== null && this.accumulator.direction !== nextDirection)
      || (this.accumulator.seenMask & (1 << messageType)) !== 0
    ) {
      this.beginSequence(messageType, nibbleValue);
      return;
    }

    this.accumulator.direction = nextDirection;
    this.accumulator.lastType = messageType;
    this.accumulator.nibbles[messageType] = nibbleValue;
    this.accumulator.seenMask |= 1 << messageType;

    // Publish only a coherent, contiguous cycle containing all eight pieces.
    if (this.accumulator.seenMask === 0xff) {

      const frames =
        this.accumulator.nibbles[0] | (this.accumulator.nibbles[1] << 4);
      const seconds =
        this.accumulator.nibbles[2] | (this.accumulator.nibbles[3] << 4);
      const minutes =
        this.accumulator.nibbles[4] | (this.accumulator.nibbles[5] << 4);

      const hoursLow = this.accumulator.nibbles[6];
      const hoursHigh = this.accumulator.nibbles[7];
      const hours = hoursLow | ((hoursHigh & 0x01) << 4);

      // Frame rate from bits 1-2 of nibble 7
      const rateCode = (hoursHigh >> 1) & 0x03;
      const format = this.decodeFormat(rateCode);

      this.onTimecode({ hours, minutes, seconds, frames }, format);
      this.accumulator = this.emptyAccumulator();
    }
  }

  private handleFullFrame(data: Uint8Array): void {
    const hours = data[5] & 0x1f;
    const rateCode = (data[5] >> 5) & 0x03;
    const minutes = data[6] & 0x7f;
    const seconds = data[7] & 0x7f;
    const frames = data[8] & 0x7f;
    const format = this.decodeFormat(rateCode);

    this.onTimecode({ hours, minutes, seconds, frames }, format);
  }

  private emptyAccumulator(): MtcAccumulator {
    return { nibbles: new Array(8).fill(0), seenMask: 0, lastType: null, direction: null };
  }

  private beginSequence(messageType: number, nibbleValue: number): void {
    this.accumulator = this.emptyAccumulator();
    this.accumulator.nibbles[messageType] = nibbleValue;
    this.accumulator.seenMask = 1 << messageType;
    this.accumulator.lastType = messageType;
  }

  private decodeFormat(code: number): TimecodeFormat {
    switch (code) {
      case 0:
        return { frameRate: 24, dropFrame: "ndf" };
      case 1:
        return { frameRate: 25, dropFrame: "ndf" };
      case 2:
        return { frameRate: 29.97, dropFrame: "df" };
      case 3:
        return { frameRate: 30, dropFrame: "ndf" };
      default:
        return { frameRate: 30, dropFrame: "ndf" };
    }
  }
}
