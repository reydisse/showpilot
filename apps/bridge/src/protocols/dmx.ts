import { randomBytes } from "node:crypto";
import { UdpConnection } from "./udp.js";

type DmxProtocol = "dmx-artnet" | "dmx-sacn";

interface DmxState {
  activeScene: string;
  blackoutActive: boolean;
  masterLevel: number;
}

const CHANNEL_COUNT = 512;
const RESEND_INTERVAL_MS = 800;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return record(JSON.parse(value)) ?? {};
  } catch {
    throw new Error("DMX fixtures and scenes must use valid JSON");
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function artNetDmxPacket(universe: number, sequence: number, channels: Uint8Array): Buffer {
  const packet = Buffer.alloc(18 + CHANNEL_COUNT);
  packet.write("Art-Net\0", 0, "ascii");
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(14, 10);
  packet[12] = sequence;
  packet[13] = 0;
  packet[14] = universe & 0xff;
  packet[15] = (universe >> 8) & 0x7f;
  packet.writeUInt16BE(CHANNEL_COUNT, 16);
  Buffer.from(channels).copy(packet, 18);
  return packet;
}

export function sacnDmxPacket(input: {
  universe: number;
  sequence: number;
  channels: Uint8Array;
  cid: Buffer;
}): Buffer {
  const packet = Buffer.alloc(126 + CHANNEL_COUNT);
  packet.writeUInt16BE(0x0010, 0);
  packet.writeUInt16BE(0, 2);
  Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0, 0, 0]).copy(packet, 4);
  packet.writeUInt16BE(0x7000 | (packet.length - 16), 16);
  packet.writeUInt32BE(0x00000004, 18);
  input.cid.copy(packet, 22, 0, 16);
  packet.writeUInt16BE(0x7000 | (packet.length - 38), 38);
  packet.writeUInt32BE(0x00000002, 40);
  packet.write("ShowPilot Bridge", 44, "utf8");
  packet[108] = 100;
  packet.writeUInt16BE(0, 109);
  packet[111] = input.sequence;
  packet[112] = 0;
  packet.writeUInt16BE(input.universe, 113);
  packet.writeUInt16BE(0x7000 | (packet.length - 115), 115);
  packet[117] = 0x02;
  packet[118] = 0xa1;
  packet.writeUInt16BE(0, 119);
  packet.writeUInt16BE(1, 121);
  packet.writeUInt16BE(CHANNEL_COUNT + 1, 123);
  packet[125] = 0;
  Buffer.from(input.channels).copy(packet, 126);
  return packet;
}

export class DmxConnection {
  private udp = new UdpConnection();
  private values = new Uint8Array(CHANNEL_COUNT);
  private fixtures: Record<string, unknown> = {};
  private scenes: Record<string, unknown> = {};
  private sequence = 0;
  private resendTimer: NodeJS.Timeout | null = null;
  private cid = randomBytes(16);
  private universe = 1;
  private state: DmxState = { activeScene: "", blackoutActive: false, masterLevel: 100 };

  constructor(
    private readonly protocol: DmxProtocol,
    private readonly onState: (state: DmxState) => void,
  ) {}

  async connect(host: string, port: number, settings: Record<string, unknown>): Promise<void> {
    const minimumUniverse = this.protocol === "dmx-sacn" ? 1 : 0;
    const maximumUniverse = this.protocol === "dmx-sacn" ? 63_999 : 32_767;
    this.universe = integer(settings.universe ?? minimumUniverse, "Universe", minimumUniverse, maximumUniverse);
    this.fixtures = parseJsonRecord(settings.fixtures);
    this.scenes = parseJsonRecord(settings.scenes);
    await this.udp.connect(host, port);
    try {
      await this.sendFrame();
    } catch (error) {
      this.udp.disconnect();
      throw error;
    }
    this.resendTimer = setInterval(() => void this.sendFrame().catch(() => {}), RESEND_INTERVAL_MS);
    this.emitState();
  }

  disconnect(): void {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = null;
    this.udp.disconnect();
  }

  isConnected(): boolean {
    return this.udp.isConnected();
  }

  async executeAction(actionId: string, params: Record<string, unknown>): Promise<void> {
    switch (actionId) {
      case "set_channel":
        this.setChannel(integer(params.channel, "Channel", 1, CHANNEL_COUNT), integer(params.value, "Value", 0, 255));
        this.state.activeScene = "";
        break;
      case "set_intensity": {
        const fixture = typeof params.fixture === "string" ? params.fixture.trim() : "";
        const configured = this.fixtures[fixture];
        const channel = typeof configured === "number" ? configured : record(configured)?.channel;
        this.setChannel(integer(channel, `Fixture ${fixture} channel`, 1, CHANNEL_COUNT), Math.round(integer(params.intensity, "Intensity", 0, 100) * 2.55));
        this.state.activeScene = "";
        break;
      }
      case "recall_scene": {
        const name = typeof params.scene === "string" ? params.scene.trim() : "";
        const scene = record(this.scenes[name]);
        if (!name || !scene) throw new Error(`DMX scene ${name || "(empty)"} is not configured`);
        this.values.fill(0);
        for (const [channel, value] of Object.entries(scene)) {
          this.setChannel(integer(channel, "Scene channel", 1, CHANNEL_COUNT), integer(value, "Scene value", 0, 255));
        }
        this.state.activeScene = name;
        break;
      }
      case "blackout":
        this.state.blackoutActive = true;
        break;
      case "restore":
        this.state.blackoutActive = false;
        break;
      case "set_master":
        this.state.masterLevel = integer(params.level, "Master level", 0, 100);
        break;
      default:
        throw new Error(`Unknown DMX action: ${actionId}`);
    }
    await this.sendFrame();
    this.emitState();
  }

  private setChannel(channel: number, value: number): void {
    this.values[channel - 1] = value;
  }

  private outputValues(): Uint8Array {
    if (this.state.blackoutActive) return new Uint8Array(CHANNEL_COUNT);
    if (this.state.masterLevel === 100) return this.values;
    const scale = this.state.masterLevel / 100;
    return this.values.map((value) => Math.round(value * scale));
  }

  private emitState(): void {
    this.onState({ ...this.state });
  }

  private async sendFrame(): Promise<void> {
    this.sequence = this.sequence >= 255 ? 1 : this.sequence + 1;
    const channels = this.outputValues();
    const packet = this.protocol === "dmx-artnet"
      ? artNetDmxPacket(this.universe, this.sequence, channels)
      : sacnDmxPacket({ universe: this.universe, sequence: this.sequence, channels, cid: this.cid });
    await this.udp.send(packet);
  }
}
