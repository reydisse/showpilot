import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";
import { getSharedBridgeProxy } from "../../bridge-proxy";

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

  private proxy = null as ReturnType<typeof getSharedBridgeProxy> | null;
  private target = "";
  private connected = false;

  async connect(settings: Record<string, unknown>): Promise<void> {
    const orgId = String(settings.orgId || "");
    const host = String(settings.host || "");
    const port = Number(settings.port || 23);
    if (!orgId || !host || !Number.isFinite(port) || port <= 0) {
      throw new Error("Bridge, host, and port are required");
    }

    this.proxy = getSharedBridgeProxy(orgId);
    if (!this.proxy.isBridgeOnline()) {
      throw new Error("Bridge is offline");
    }

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
    if (this.proxy && this.target) {
      this.proxy.disconnectDevice(this.target);
    }
    this.connected = false;
  }
  async sendCommand(command: string): Promise<string | void> {
    if (!this.proxy || !this.connected) throw new Error("Not connected");
    return await this.proxy.sendCommand(this.protocolId, this.target, command);
  }
  onEvent(): () => void { return () => {}; }
  isConnected(): boolean { return this.connected; }
}
