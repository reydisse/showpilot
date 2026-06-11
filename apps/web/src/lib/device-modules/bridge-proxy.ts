/**
 * BridgeProxy — routes protocol commands through the ShowPilot Bridge agent
 * via the BridgeRelay Durable Object WebSocket.
 *
 * Used by bridge-required protocol drivers (PJLink, TCP, VISCA, OSC)
 * when a bridge is connected.
 */

type BridgeStatusCallback = (online: boolean) => void;
type DeviceStatusCallback = (target: string, connected: boolean) => void;

interface PendingCommand {
  resolve: (response?: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeProxy {
  private ws: WebSocket | null = null;
  private connected = false;
  private bridgeOnline = false;
  private pendingCommands = new Map<string, PendingCommand>();
  private commandId = 0;
  private statusListeners = new Set<BridgeStatusCallback>();
  private deviceStatusListeners = new Set<DeviceStatusCallback>();
  private eventListeners = new Set<(target: string, eventName: string, data: string) => void>();
  private orgId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(orgId: string) {
    this.orgId = orgId;
  }

  /** Connect to BridgeRelay DO */
  connect(): void {
    if (this.ws) return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/api/bridge/${this.orgId}/ws?role=client`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.bridgeOnline = false;
      this.notifyStatus(false);
      // Auto-reconnect
      this.reconnectTimer = setTimeout(() => {
        this.ws = null;
        this.connect();
      }, 5000);
    };

    this.ws.onerror = () => {};
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.bridgeOnline = false;
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Disconnected"));
    }
    this.pendingCommands.clear();
  }

  /** Is the bridge agent online? */
  isBridgeOnline(): boolean {
    return this.bridgeOnline;
  }

  /** Listen for bridge online/offline changes */
  onBridgeStatus(callback: BridgeStatusCallback): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  /** Listen for device connected/disconnected changes */
  onDeviceStatus(callback: DeviceStatusCallback): () => void {
    this.deviceStatusListeners.add(callback);
    return () => this.deviceStatusListeners.delete(callback);
  }

  /** Listen for device events from bridge */
  onDeviceEvent(callback: (target: string, eventName: string, data: string) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /** Send a command to a device through the bridge */
  async sendCommand(
    protocol: string,
    target: string,
    command: string
  ): Promise<string | void> {
    if (!this.connected || !this.bridgeOnline) {
      throw new Error("Bridge is offline");
    }

    const id = `cmd_${++this.commandId}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error("Command timeout"));
      }, 10000);

      this.pendingCommands.set(id, { resolve, reject, timer });

      this.send({
        type: "command",
        id,
        protocol,
        target,
        command,
      });
    });
  }

  /** Request bridge to connect to a device */
  connectDevice(protocol: string, target: string, settings?: Record<string, unknown>): void {
    this.send({ type: "connect-device", protocol, target, settings: settings ?? {} });
  }

  /** Request bridge to disconnect from a device */
  disconnectDevice(target: string): void {
    this.send({ type: "disconnect-device", target });
  }

  // ─── Private ────────────────────────────────────────────

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "bridge-status":
        this.bridgeOnline = msg.online as boolean;
        this.notifyStatus(this.bridgeOnline);
        break;

      case "command-response": {
        const id = msg.id as string;
        const pending = this.pendingCommands.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(id);
          if (msg.success) {
            pending.resolve(msg.response as string | undefined);
          } else {
            pending.reject(new Error((msg.error as string) ?? "Command failed"));
          }
        }
        break;
      }

      case "device-event": {
        const target = msg.target as string;
        const eventName = msg.eventName as string;
        const data = msg.data as string;
        for (const cb of this.eventListeners) {
          cb(target, eventName, data);
        }
        break;
      }

      case "device-status": {
        const target = msg.target as string;
        const connected = Boolean(msg.connected);
        for (const cb of this.deviceStatusListeners) {
          cb(target, connected);
        }
        break;
      }
    }
  }

  private send(data: object): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private notifyStatus(online: boolean): void {
    for (const cb of this.statusListeners) {
      cb(online);
    }
  }
}

const sharedBridgeProxies = new Map<string, BridgeProxy>();

export function getSharedBridgeProxy(orgId: string): BridgeProxy {
  let proxy = sharedBridgeProxies.get(orgId);
  if (!proxy) {
    proxy = new BridgeProxy(orgId);
    proxy.connect();
    sharedBridgeProxies.set(orgId, proxy);
  }
  return proxy;
}
