import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";

/**
 * Wake-on-LAN protocol driver — bridge-required.
 * Sends magic packet (6x 0xFF + 16x MAC) to power on devices.
 * One-shot, no persistent connection, no feedback.
 */
export class WolDriver implements ProtocolDriver {
  readonly protocolId = "wol";
  readonly transport: TransportType = "udp";
  readonly connectivity: ConnectivityMode = "bridge-required";
  readonly baseConfigFields: AdapterField[] = [
    { key: "mac", label: "MAC Address", placeholder: "AA:BB:CC:DD:EE:FF", required: true },
    { key: "broadcastAddress", label: "Broadcast Address", placeholder: "255.255.255.255" },
  ];

  async connect(): Promise<void> {
    throw new Error("Bridge agent required for Wake-on-LAN");
  }
  disconnect(): void {}
  async sendCommand(): Promise<string | void> {
    throw new Error("Bridge agent required");
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return false; }
}
