import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";
import { getSharedBridgeProxy } from "../../bridge-proxy";

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

  private proxy = null as ReturnType<typeof getSharedBridgeProxy> | null;
  private mac = "";
  private connected = false;

  async connect(settings: Record<string, unknown>): Promise<void> {
    const orgId = String(settings.orgId || "");
    this.mac = String(settings.mac || "");
    if (!orgId || !this.mac) {
      throw new Error("Bridge and MAC address are required");
    }

    this.proxy = getSharedBridgeProxy(orgId);
    if (!this.proxy.isBridgeOnline()) throw new Error("Bridge is offline");
    this.connected = true;
  }
  disconnect(): void {
    this.connected = false;
  }
  async sendCommand(command: string): Promise<string | void> {
    if (!this.proxy || !this.connected) throw new Error("Not connected");
    return await this.proxy.sendCommand(this.protocolId, "wol", command || this.mac);
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return this.connected; }
}
