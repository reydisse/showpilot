import type { TimecodeValue, FrameRate } from "@/types/timecode";

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
  count: number;
}

export interface MtcSourceCallback {
  (tc: TimecodeValue, frameRate: FrameRate): void;
}

export class MtcSource {
  private midiAccess: MIDIAccess | null = null;
  private input: MIDIInput | null = null;
  private accumulator: MtcAccumulator = { nibbles: new Array(8).fill(0), count: 0 };
  private onTimecode: MtcSourceCallback;

  constructor(callback: MtcSourceCallback) {
    this.onTimecode = callback;
  }

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
  }

  static async getInputs(): Promise<MIDIInput[]> {
    if (!MtcSource.isSupported()) return [];
    const access = await navigator.requestMIDIAccess({ sysex: true });
    return [...access.inputs.values()];
  }

  async start(inputId: string): Promise<void> {
    if (!MtcSource.isSupported()) {
      throw new Error("Web MIDI API not supported in this browser");
    }

    this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
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
    this.accumulator = { nibbles: new Array(8).fill(0), count: 0 };
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

    this.accumulator.nibbles[messageType] = nibbleValue;
    this.accumulator.count++;

    // After 8 quarter-frame messages, we have a complete timecode
    if (this.accumulator.count >= 8) {
      this.accumulator.count = 0;

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
      const frameRate = this.decodeFrameRate(rateCode);

      this.onTimecode({ hours, minutes, seconds, frames }, frameRate);
    }
  }

  private handleFullFrame(data: Uint8Array): void {
    const hours = data[5] & 0x1f;
    const rateCode = (data[5] >> 5) & 0x03;
    const minutes = data[6] & 0x7f;
    const seconds = data[7] & 0x7f;
    const frames = data[8] & 0x7f;
    const frameRate = this.decodeFrameRate(rateCode);

    this.onTimecode({ hours, minutes, seconds, frames }, frameRate);
  }

  private decodeFrameRate(code: number): FrameRate {
    switch (code) {
      case 0:
        return 24;
      case 1:
        return 25;
      case 2:
        return 29.97;
      case 3:
        return 30;
      default:
        return 30;
    }
  }
}
