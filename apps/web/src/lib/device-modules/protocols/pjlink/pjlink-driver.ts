import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";

/**
 * PJLink protocol driver — bridge-required.
 * Covers 90%+ of projectors: Epson, Panasonic, Sony, Christie, Barco, NEC, etc.
 * PJLink Class 1 + Class 2 over TCP port 4352.
 */
export class PJLinkDriver implements ProtocolDriver {
  readonly protocolId = "pjlink";
  readonly transport: TransportType = "tcp";
  readonly connectivity: ConnectivityMode = "bridge-required";
  readonly baseConfigFields: AdapterField[] = [
    { key: "host", label: "Projector IP", placeholder: "192.168.1.200", required: true },
    { key: "port", label: "Port", placeholder: "4352", type: "number" },
    { key: "password", label: "PJLink Password", type: "password" },
  ];

  async connect(): Promise<void> {
    throw new Error("Bridge agent required for PJLink (TCP) connections");
  }
  disconnect(): void {}
  async sendCommand(): Promise<string | void> {
    throw new Error("Bridge agent required");
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return false; }
}
