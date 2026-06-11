import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";
import { getSharedBridgeProxy } from "../../bridge-proxy";

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

  private proxy = null as ReturnType<typeof getSharedBridgeProxy> | null;
  private target = "";
  private connected = false;

  async connect(settings: Record<string, unknown>): Promise<void> {
    const orgId = String(settings.orgId || "");
    const host = String(settings.host || "");
    const port = Number(settings.port || 52381);
    if (!orgId || !host || !Number.isFinite(port) || port <= 0) {
      throw new Error("Bridge, host, and port are required");
    }

    this.proxy = getSharedBridgeProxy(orgId);
    if (!this.proxy.isBridgeOnline()) throw new Error("Bridge is offline");

    this.target = `${host}:${port}`;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Device connect timeout"));
      }, 5000);

      const unsubscribe = this.proxy!.onDeviceStatus((target, isConnected) => {
        if (target !== this.target) return;
        clearTimeout(timeout);
        unsubscribe();
        this.connected = isConnected;
        if (isConnected) resolve();
        else reject(new Error("Bridge could not connect to device"));
      });

      this.proxy!.connectDevice(this.protocolId, this.target, settings);
    });
  }
  disconnect(): void {
    if (this.proxy && this.target) this.proxy.disconnectDevice(this.target);
    this.connected = false;
  }
  async sendCommand(command: string): Promise<string | void> {
    if (!this.proxy || !this.connected) throw new Error("Not connected");
    return await this.proxy.sendCommand(this.protocolId, this.target, command);
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return this.connected; }
}
