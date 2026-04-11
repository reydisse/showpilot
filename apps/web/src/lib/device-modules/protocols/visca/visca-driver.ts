import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";

/**
 * VISCA-over-IP protocol driver — bridge-required.
 * Covers PTZ cameras: Sony, Panasonic, PTZOptics, Marshall, BirdDog.
 * UDP port 52381 (standard VISCA-over-IP).
 */
export class ViscaDriver implements ProtocolDriver {
  readonly protocolId = "visca-ip";
  readonly transport: TransportType = "udp";
  readonly connectivity: ConnectivityMode = "bridge-required";
  readonly baseConfigFields: AdapterField[] = [
    { key: "host", label: "Camera IP", placeholder: "192.168.1.180", required: true },
    { key: "port", label: "Port", placeholder: "52381", type: "number" },
    { key: "cameraAddress", label: "Camera Address (1-7)", placeholder: "1", type: "number" },
  ];

  async connect(): Promise<void> {
    throw new Error("Bridge agent required for VISCA (UDP) connections");
  }
  disconnect(): void {}
  async sendCommand(): Promise<string | void> {
    throw new Error("Bridge agent required");
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return false; }
}
