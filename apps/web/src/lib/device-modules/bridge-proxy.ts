/**
 * BridgeProxy — routes protocol commands through the ShowPilot Bridge agent
 * via the BridgeRelay Durable Object WebSocket.
 *
 * Used by bridge-required protocol drivers (PJLink, TCP, VISCA, OSC)
 * when a bridge is connected.
 */

function isMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type BridgeStatusCallback = (online: boolean, error?: string) => void;
type DeviceStatusCallback = (target: string, connected: boolean, error?: string) => void;

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
  private pendingConnections = new Set<string>();
  private statusListeners = new Set<BridgeStatusCallback>();
  private deviceStatusListeners = new Set<DeviceStatusCallback>();
  private eventListeners = new Set<(target: string, eventName: string, data: string) => void>();
  private orgId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lastError: string | null = null;

  constructor(orgId: string, private readonly role: "client" | "propresenter-viewer" = "client") {
    this.orgId = orgId;
  }

  /** Connect to BridgeRelay DO. Transport readiness requires a status snapshot. */
  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/api/bridge/${encodeURIComponent(this.orgId)}/ws?role=${this.role}`;
    let socket: WebSocket;
    try { socket = new WebSocket(url); }
    catch { this.reportConnectionFailure("Could not open the Bridge connection. Reconnecting."); return; }
    this.ws = socket;
    const current = () => this.ws === socket && this.shouldReconnect;
    this.handshakeTimer = setTimeout(() => {
      if (current()) this.dropConnection(socket, "Bridge status was not confirmed within five seconds. Reconnecting.");
    }, 5000);
    socket.onopen = () => { if (current()) this.connected = true; };
    socket.onmessage = event => {
      if (!current()) return;
      try { this.handleMessage(JSON.parse(event.data)); }
      catch { this.dropConnection(socket, "A Bridge update could not be read. Reconnecting to confirm device status."); }
    };
    socket.onclose = () => { if (current()) this.dropConnection(socket, "Bridge connection lost. Command outcomes are unconfirmed. Reconnecting."); };
    socket.onerror = () => { if (current()) this.dropConnection(socket, "Bridge connection failed. Command outcomes are unconfirmed. Reconnecting."); };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    const socket = this.ws;
    this.ws = null;
    this.connected = false;
    this.bridgeOnline = false;
    this.lastError = null;
    this.rejectPending("Bridge disconnected. Command outcomes are unconfirmed.");
    socket?.close();
    this.notifyStatus(false);
  }

  getLastError(): string | null { return this.lastError; }

  private rejectPending(message: string): void {
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingCommands.clear();
    const targets = [...this.pendingConnections];
    this.pendingConnections.clear();
    for (const target of targets) this.notifyDeviceStatus(target, false, message);
  }

  private dropConnection(socket: WebSocket, message: string): void {
    if (this.ws !== socket) return;
    this.ws = null;
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    socket.close();
    this.reportConnectionFailure(message);
  }

  private reportConnectionFailure(message: string): void {
    this.connected = false;
    this.bridgeOnline = false;
    this.lastError = message;
    this.rejectPending(message);
    this.notifyStatus(false, message);
    if (!this.shouldReconnect || this.reconnectTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
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

      try { this.send({ type: "command", id, protocol, target, command }); }
      catch {
        clearTimeout(timer); this.pendingCommands.delete(id);
        reject(new Error("Bridge command could not be sent. Review device state before retrying."));
      }
    });
  }

  /** Request bridge to connect to a device */
  connectDevice(protocol: string, target: string, settings?: Record<string, unknown>): void {
    try {
      if (!this.connected || !this.bridgeOnline || this.ws?.readyState !== 1) throw new Error("Bridge connection is unavailable. Reconnect and try again.");
      this.pendingConnections.add(target);
      this.send({ type: "connect-device", protocol, target, settings: settings ?? {} });
    } catch {
      this.notifyDeviceStatus(target, false, "Bridge connection is unavailable. Reconnect and try again.");
    }
  }

  /** Request bridge to disconnect from a device */
  disconnectDevice(target: string): void {
    try { this.send({ type: "disconnect-device", target }); }
    catch { this.notifyDeviceStatus(target, false, "Device disconnect could not be confirmed. Check the venue Bridge."); }
  }

  // ─── Private ────────────────────────────────────────────

  private handleMessage(value: unknown): void {
    if (!isMessageRecord(value)) throw new Error("Invalid Bridge message");
    const msg = value;
    if (typeof msg.type !== "string") throw new Error("Missing Bridge message type");
    switch (msg.type) {
      case "bridge-status":
        if (typeof msg.online !== "boolean") throw new Error("Invalid Bridge status");
        if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.reconnectAttempts = 0;
        this.bridgeOnline = msg.online;
        this.lastError = msg.online ? null : "Venue Bridge is offline. Start it on the venue network to reconnect.";
        if (!msg.online) this.rejectPending("Venue Bridge went offline. Command outcomes are unconfirmed.");
        this.notifyStatus(this.bridgeOnline, this.lastError ?? undefined);
        break;

      case "ping-response":
        if (typeof msg.success !== "boolean") throw new Error("Invalid Bridge ping response");
        if (msg.success === false) {
          this.bridgeOnline = false;
          this.lastError = typeof msg.error === "string" ? msg.error : "Bridge connectivity check failed";
          this.rejectPending("Bridge connectivity check failed. Command outcomes are unconfirmed.");
          this.notifyStatus(false, this.lastError);
        }
        break;

      case "command-response": {
        if (typeof msg.id !== "string" || typeof msg.success !== "boolean" || (msg.response !== undefined && typeof msg.response !== "string")) throw new Error("Invalid command response");
        const id = msg.id;
        const pending = this.pendingCommands.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(id);
          if (msg.success) {
            pending.resolve(msg.response);
          } else {
            pending.reject(new Error(typeof msg.error === "string" ? msg.error : "Command failed"));
          }
        }
        this.notifyDeviceEvent(msg);
        break;
      }

      case "device-event": {
        if (typeof msg.target !== "string" || typeof msg.eventName !== "string" || typeof msg.data !== "string") throw new Error("Invalid device event");
        this.notifyDeviceEvent(msg);
        break;
      }

      case "device-status": {
        if (typeof msg.target !== "string" || typeof msg.connected !== "boolean") throw new Error("Invalid device status");
        this.notifyDeviceStatus(msg.target, msg.connected, typeof msg.error === "string" ? msg.error : undefined);
        break;
      }
    }
  }

  private send(data: object): void {
    const socket = this.ws;
    if (!socket || socket.readyState !== 1) throw new Error("Bridge connection is unavailable");
    try { socket.send(JSON.stringify(data)); }
    catch {
      this.dropConnection(socket, "Bridge send failed. Command outcomes are unconfirmed. Reconnecting.");
      throw new Error("Bridge send failed");
    }
  }

  private notifyStatus(online: boolean, error?: string): void {
    for (const cb of this.statusListeners) cb(online, error);
  }

  private notifyDeviceStatus(target: string, connected: boolean, error?: string): void {
    this.pendingConnections.delete(target);
    for (const cb of this.deviceStatusListeners) cb(target, connected, error);
  }

  private notifyDeviceEvent(msg: Record<string, unknown>): void {
    if (
      typeof msg.target !== "string" ||
      typeof msg.eventName !== "string" ||
      typeof msg.data !== "string"
    ) {
      return;
    }
    for (const cb of this.eventListeners) {
      cb(msg.target, msg.eventName, msg.data);
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

const sharedProPresenterProxies = new Map<string, BridgeProxy>();

/** Separate read-only transport: viewing slides must not grant device control. */
export function getSharedProPresenterProxy(orgId: string): BridgeProxy {
  let proxy = sharedProPresenterProxies.get(orgId);
  if (!proxy) {
    proxy = new BridgeProxy(orgId, "propresenter-viewer");
    proxy.connect();
    sharedProPresenterProxies.set(orgId, proxy);
  }
  return proxy;
}
