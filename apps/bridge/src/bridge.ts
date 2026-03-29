import WebSocket from "ws";
import { TcpConnection } from "./protocols/tcp.js";
import { UdpConnection } from "./protocols/udp.js";
import { encodeOscMessage, type OscArg } from "./protocols/osc.js";

interface BridgeOptions {
  url: string;
  key?: string;
  reconnect?: boolean;
}

interface CommandMessage {
  type: "command";
  id: string;
  protocol: string;
  target: string;
  command: string;
  settings?: Record<string, unknown>;
}

interface ConnectDeviceMessage {
  type: "connect-device";
  protocol: string;
  target: string;
  settings: Record<string, unknown>;
}

type IncomingMessage = CommandMessage | ConnectDeviceMessage | { type: string; [k: string]: unknown };

/**
 * ShowPilot Bridge — connects to ShowPilot cloud via WebSocket
 * and proxies commands to local network devices.
 */
export class Bridge {
  private ws: WebSocket | null = null;
  private url: string;
  private key: string | undefined;
  private reconnect: boolean;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private tcpConnections = new Map<string, TcpConnection>();
  private udpConnections = new Map<string, UdpConnection>();
  private startTime = Date.now();

  constructor(options: BridgeOptions) {
    this.url = options.url;
    this.key = options.key;
    this.reconnect = options.reconnect ?? true;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.reconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    // Disconnect all device connections
    for (const conn of this.tcpConnections.values()) conn.disconnect();
    for (const conn of this.udpConnections.values()) conn.disconnect();
    this.tcpConnections.clear();
    this.udpConnections.clear();
  }

  private connect(): void {
    const wsUrl = `${this.url}?role=bridge${this.key ? `&key=${this.key}` : ""}`;
    console.log(`[bridge] Connecting to ${this.url}...`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on("open", () => {
      console.log("[bridge] Connected to ShowPilot");
      this.sendStatus();
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as IncomingMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore
      }
    });

    this.ws.on("close", () => {
      console.log("[bridge] Disconnected");
      if (this.reconnect) {
        console.log("[bridge] Reconnecting in 5s...");
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on("error", (err) => {
      console.error("[bridge] WebSocket error:", err.message);
    });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case "command":
        await this.handleCommand(msg as CommandMessage);
        break;
      case "connect-device":
        await this.handleConnectDevice(msg as ConnectDeviceMessage);
        break;
      case "disconnect-device":
        this.handleDisconnectDevice(msg as { target: string });
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
    }
  }

  private async handleCommand(msg: CommandMessage): Promise<void> {
    try {
      let response: string | void;

      switch (msg.protocol) {
        case "tcp-command":
        case "pjlink":
          response = await this.executeTcpCommand(msg.target, msg.command);
          break;
        case "osc":
          await this.executeOscCommand(msg.target, msg.command);
          break;
        case "udp":
        case "visca-ip":
          await this.executeUdpCommand(msg.target, msg.command);
          break;
        case "wol":
          await this.executeWol(msg.command);
          break;
        default:
          throw new Error(`Unknown protocol: ${msg.protocol}`);
      }

      this.send({
        type: "command-response",
        id: msg.id,
        success: true,
        response: response ?? undefined,
      });
    } catch (err) {
      this.send({
        type: "command-response",
        id: msg.id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleConnectDevice(msg: ConnectDeviceMessage): Promise<void> {
    const key = msg.target;
    const [host, portStr] = key.split(":");
    const port = parseInt(portStr || "0", 10);

    try {
      if (msg.protocol === "tcp-command" || msg.protocol === "pjlink") {
        if (!this.tcpConnections.has(key)) {
          const conn = new TcpConnection();
          await conn.connect(host, port);
          this.tcpConnections.set(key, conn);
        }
      } else if (msg.protocol === "osc" || msg.protocol === "udp" || msg.protocol === "visca-ip") {
        if (!this.udpConnections.has(key)) {
          const conn = new UdpConnection();
          await conn.connect(host, port);
          this.udpConnections.set(key, conn);
        }
      }

      this.send({ type: "device-status", target: key, connected: true });
      this.sendStatus();
    } catch (err) {
      this.send({
        type: "device-status",
        target: key,
        connected: false,
      });
    }
  }

  private handleDisconnectDevice(msg: { target: string }): void {
    const tcp = this.tcpConnections.get(msg.target);
    if (tcp) {
      tcp.disconnect();
      this.tcpConnections.delete(msg.target);
    }
    const udp = this.udpConnections.get(msg.target);
    if (udp) {
      udp.disconnect();
      this.udpConnections.delete(msg.target);
    }
    this.send({ type: "device-status", target: msg.target, connected: false });
    this.sendStatus();
  }

  // ─── Protocol Execution ─────────────────────────────────

  private async executeTcpCommand(target: string, command: string): Promise<string> {
    let conn = this.tcpConnections.get(target);
    if (!conn || !conn.isConnected()) {
      // Auto-connect
      const [host, portStr] = target.split(":");
      conn = new TcpConnection();
      await conn.connect(host, parseInt(portStr, 10));
      this.tcpConnections.set(target, conn);
    }
    return await conn.sendCommand(command);
  }

  private async executeOscCommand(target: string, command: string): Promise<void> {
    let conn = this.udpConnections.get(target);
    if (!conn || !conn.isConnected()) {
      const [host, portStr] = target.split(":");
      conn = new UdpConnection();
      await conn.connect(host, parseInt(portStr, 10));
      this.udpConnections.set(target, conn);
    }

    // Parse OSC command: "/address type:value type:value"
    // e.g., "/ch/01/mix/fader f:0.75" or "/ch/01/mix/on i:1"
    const parts = command.trim().split(/\s+/);
    const address = parts[0];
    const args: OscArg[] = parts.slice(1).map((p) => {
      const [type, val] = p.split(":");
      if (type === "f") return { type: "f" as const, value: parseFloat(val) };
      if (type === "i") return { type: "i" as const, value: parseInt(val, 10) };
      return { type: "s" as const, value: val };
    });

    const buf = encodeOscMessage(address, args);
    await conn.send(buf);
  }

  private async executeUdpCommand(target: string, command: string): Promise<void> {
    let conn = this.udpConnections.get(target);
    if (!conn || !conn.isConnected()) {
      const [host, portStr] = target.split(":");
      conn = new UdpConnection();
      await conn.connect(host, parseInt(portStr, 10));
      this.udpConnections.set(target, conn);
    }

    // Command is hex string for VISCA, or raw bytes
    const buf = Buffer.from(command.replace(/\s+/g, ""), "hex");
    await conn.send(buf);
  }

  private async executeWol(command: string): Promise<void> {
    // command = MAC address "AA:BB:CC:DD:EE:FF"
    const mac = command.replace(/[:-]/g, "");
    if (mac.length !== 12) throw new Error("Invalid MAC address");

    const macBytes = Buffer.from(mac, "hex");
    // Magic packet: 6x 0xFF + 16x MAC
    const packet = Buffer.alloc(102);
    packet.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) {
      macBytes.copy(packet, 6 + i * 6);
    }

    const conn = new UdpConnection();
    await conn.connect("255.255.255.255", 9);
    await conn.send(packet);
    conn.disconnect();
  }

  // ─── Helpers ────────────────────────────────────────────

  private send(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private sendStatus(): void {
    this.send({
      type: "bridge-status",
      version: "0.1.0",
      devices: this.tcpConnections.size + this.udpConnections.size,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    });
  }
}
