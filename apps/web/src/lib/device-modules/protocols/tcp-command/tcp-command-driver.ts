import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";

/**
 * Generic TCP command protocol driver — bridge-required.
 * Covers line-based TCP devices: Extron SIS, QSC Q-SYS QRC, Biamp Tesira,
 * Lightware, Crestron, and other matrix switchers/DSPs.
 */
export class TcpCommandDriver implements ProtocolDriver {
  readonly protocolId = "tcp-command";
  readonly transport: TransportType = "tcp";
  readonly connectivity: ConnectivityMode = "bridge-required";
  readonly baseConfigFields: AdapterField[] = [
    { key: "host", label: "Device IP", placeholder: "192.168.1.100", required: true },
    { key: "port", label: "Port", placeholder: "23", type: "number" },
    { key: "lineTerminator", label: "Line Terminator", placeholder: "\\r\\n" },
  ];

  async connect(): Promise<void> {
    throw new Error("Bridge agent required for TCP connections");
  }
  disconnect(): void {}
  async sendCommand(): Promise<string | void> {
    throw new Error("Bridge agent required");
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return false; }
}
