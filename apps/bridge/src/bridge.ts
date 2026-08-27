import WebSocket, { type ClientOptions } from "ws";
import { Atem, type AtemState } from "atem-connection";
import { TcpConnection } from "./protocols/tcp.js";
import { UdpConnection } from "./protocols/udp.js";
import { encodeOscMessage, type OscArg } from "./protocols/osc.js";
import {
  ProPresenterBridge,
  type PPBridgeDebugState,
} from "./protocols/propresenter.js";
import { BRIDGE_VERSION } from "./version.js";

interface BridgeOptions {
  url: string;
  key?: string;
  reconnect?: boolean;
  propresenter?: {
    host: string;
    port?: number;
    apiPort?: number;
    password?: string;
  };
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

const CONNECT_DEVICE_PROTOCOLS = new Set([
  "propresenter",
  "http-command",
  "atem",
  "tcp-command",
  "pjlink",
  "osc",
  "udp",
  "visca-ip",
]);

export function isSupportedConnectProtocol(protocol: string): boolean {
  return CONNECT_DEVICE_PROTOCOLS.has(protocol);
}

export function connectedBridgeTargets(...groups: Iterable<string>[]): string[] {
  return [...new Set(groups.flatMap((group) => [...group]))].sort();
}

type IncomingMessage =
  | CommandMessage
  | ConnectDeviceMessage
  | { type: string; [k: string]: unknown };

export function bridgeWebSocketOptions(
  url: string,
  key?: string,
): { url: string; options?: ClientOptions } {
  const wsUrlObject = new URL(url);
  wsUrlObject.searchParams.set("role", "bridge");
  wsUrlObject.searchParams.delete("key");
  return {
    url: wsUrlObject.toString(),
    options: key ? { headers: { "x-showpilot-api-key": key } } : undefined,
  };
}

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
  private ppConnections = new Map<string, ProPresenterBridge>();
  private atemConnections = new Map<string, Atem>();
  private httpDeviceSettings = new Map<string, Record<string, unknown>>();
  private startTime = Date.now();
  private propresenter?: BridgeOptions["propresenter"];

  constructor(options: BridgeOptions) {
    this.url = options.url;
    this.key = options.key;
    this.reconnect = options.reconnect ?? true;
    this.propresenter = options.propresenter;
  }

  getStatus() {
    const propresenter: Record<string, PPBridgeDebugState> = {};
    for (const [target, bridge] of this.ppConnections.entries()) {
      propresenter[target] = bridge.getDebugState();
    }

    return {
      connectedToShowPilot: this.ws?.readyState === WebSocket.OPEN,
      propresenter,
    };
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
    for (const conn of this.ppConnections.values()) conn.disconnect();
    for (const conn of this.tcpConnections.values()) conn.disconnect();
    for (const conn of this.udpConnections.values()) conn.disconnect();
    for (const conn of this.atemConnections.values()) void conn.disconnect();
    this.ppConnections.clear();
    this.tcpConnections.clear();
    this.udpConnections.clear();
    this.atemConnections.clear();
  }

  private connect(): void {
    const connection = bridgeWebSocketOptions(this.url, this.key);
    console.log(`[bridge] Connecting to ${this.url}...`);

    this.ws = new WebSocket(connection.url, connection.options);

    this.ws.on("open", () => {
      console.log("[bridge] Connected to ShowPilot");
      this.sendStatus();
      void this.ensureProPresenterConnection().catch((error) => {
        console.error(
          "[bridge] ProPresenter connection failed:",
          error instanceof Error ? error.message : String(error),
        );
      });
      for (const pp of this.ppConnections.values()) {
        pp.replayCurrentSlide();
      }
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as IncomingMessage;
        this.handleMessage(msg);
      } catch {
        // Ignore
      }
    });

    this.ws.on("close", (code, reason) => {
      const detail = reason.toString().trim();
      if (code === 1002 && detail.toLowerCase().includes("expected 101")) {
        console.error(
          "[bridge] Connection rejected before WebSocket upgrade. Check the organization slug and Bridge API key.",
        );
      }
      console.log(
        `[bridge] Disconnected (code ${code}${detail ? `: ${detail}` : ""})`,
      );
      if (this.reconnect) {
        console.log("[bridge] Reconnecting in 5s...");
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on("error", (err) => {
      if (err.message.includes("Unexpected server response: 401")) {
        console.error(
          "[bridge] Authentication failed (HTTP 401). Check the organization slug and Bridge API key.",
        );
        return;
      }
      const responseMatch = err.message.match(
        /Unexpected server response: (\d+)/,
      );
      if (responseMatch) {
        console.error(
          `[bridge] Connection rejected (HTTP ${responseMatch[1]}). Check the ShowPilot site URL and organization slug.`,
        );
        return;
      }
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
        this.handleDisconnectDevice({
          target: (msg as { target?: string }).target || "",
        });
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
    }
  }

  private async handleCommand(msg: CommandMessage): Promise<void> {
    try {
      let response: string | void = undefined;

      switch (msg.protocol) {
        case "tcp-command":
        case "pjlink":
          response = await this.executeTcpCommand(msg.target, msg.command);
          break;
        case "osc":
          await this.executeOscCommand(msg.target, msg.command);
          break;
        case "http-command":
          response = await this.executeHttpCommand(msg.target, msg.command);
          break;
        case "udp":
        case "visca-ip":
          await this.executeUdpCommand(msg.target, msg.command);
          break;
        case "propresenter":
          await this.executePPCommand(msg.target, msg.command);
          break;
        case "atem":
          await this.executeAtemCommand(msg.target, msg.command);
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
      if (!isSupportedConnectProtocol(msg.protocol)) {
        throw new Error(`Unknown protocol: ${msg.protocol}`);
      }

      if (msg.protocol === "propresenter") {
        await this.connectProPresenter(key, msg.settings);
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "http-command") {
        this.httpDeviceSettings.set(key, msg.settings ?? {});
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "atem") {
        await this.connectAtem(key, msg.settings);
        this.send({ type: "device-status", target: key, connected: true });
        this.sendStatus();
        return;
      }

      if (msg.protocol === "tcp-command" || msg.protocol === "pjlink") {
        if (!this.tcpConnections.has(key)) {
          const conn = new TcpConnection();
          await conn.connect(host, port);
          this.tcpConnections.set(key, conn);
        }
      } else if (
        msg.protocol === "osc" ||
        msg.protocol === "udp" ||
        msg.protocol === "visca-ip"
      ) {
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
    const pp = this.ppConnections.get(msg.target);
    if (pp) {
      pp.disconnect();
      this.ppConnections.delete(msg.target);
    }
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
    const atem = this.atemConnections.get(msg.target);
    if (atem) {
      void atem.disconnect();
      this.atemConnections.delete(msg.target);
    }
    this.httpDeviceSettings.delete(msg.target);
    this.send({ type: "device-status", target: msg.target, connected: false });
    this.sendStatus();
  }

  // ─── Protocol Execution ─────────────────────────────────

  private async executePPCommand(
    target: string,
    command: string,
  ): Promise<void> {
    if (command !== "next" && command !== "previous" && command !== "clear") {
      throw new Error(`Unknown ProPresenter command: ${command}`);
    }
    const pp = this.ppConnections.get(target);
    if (!pp) throw new Error("ProPresenter is not connected");
    await pp.sendCommand(command);
  }

  private async connectAtem(
    target: string,
    settings: Record<string, unknown>,
  ): Promise<void> {
    if (this.atemConnections.has(target)) return;

    const [fallbackHost, fallbackPort] = target.split(":");
    const host =
      typeof settings.host === "string" && settings.host.trim()
        ? settings.host.trim()
        : fallbackHost;
    const port = Number(settings.port || fallbackPort || 9910);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error("ATEM host and port are required");
    }

    const atem = new Atem();
    atem.on("connected", () => {
      this.send({ type: "device-status", target, connected: true });
      if (atem.state) this.sendAtemState(target, atem, atem.state);
    });
    atem.on("disconnected", () => {
      this.send({ type: "device-status", target, connected: false });
    });
    atem.on("stateChanged", (state) => this.sendAtemState(target, atem, state));
    atem.on("error", (message) => console.error(`[atem:${target}] ${message}`));

    try {
      await atem.connect(host, port);
      this.atemConnections.set(target, atem);
    } catch (error) {
      await atem.destroy().catch(() => {});
      throw error;
    }
  }

  private sendAtemState(target: string, atem: Atem, state: AtemState): void {
    const mixEffect = state.video.mixEffects[0];
    if (!mixEffect) return;
    this.send({
      type: "device-event",
      target,
      eventName: "atem-state",
      data: JSON.stringify({
        programInput: mixEffect.programInput,
        previewInput: mixEffect.previewInput,
        transitionPosition: mixEffect.transitionPosition.handlePosition,
        ftbActive: Boolean(
          mixEffect.fadeToBlack?.isFullyBlack ||
          mixEffect.fadeToBlack?.inTransition,
        ),
        tallyProgram: atem.listVisibleInputs("program"),
        tallyPreview: atem.listVisibleInputs("preview"),
      }),
    });
  }

  private async executeAtemCommand(
    target: string,
    command: string,
  ): Promise<void> {
    const atem = this.atemConnections.get(target);
    if (!atem) throw new Error("ATEM is not connected");

    let payload: { actionId?: unknown; params?: unknown };
    try {
      payload = JSON.parse(command) as { actionId?: unknown; params?: unknown };
    } catch {
      throw new Error("Invalid ATEM command payload");
    }
    if (typeof payload.actionId !== "string")
      throw new Error("ATEM action is required");
    const params =
      payload.params && typeof payload.params === "object"
        ? (payload.params as Record<string, unknown>)
        : {};
    const integer = (name: string, minimum = 0) => {
      const value = Number(params[name]);
      if (!Number.isInteger(value) || value < minimum)
        throw new Error(`Invalid ATEM ${name}`);
      return value;
    };

    switch (payload.actionId) {
      case "set_program_input":
        await atem.changeProgramInput(integer("input", 1));
        return;
      case "set_preview_input":
        await atem.changePreviewInput(integer("input", 1));
        return;
      case "cut":
        await atem.cut();
        return;
      case "auto_transition":
        await atem.autoTransition();
        return;
      case "fade_to_black":
        await atem.fadeToBlack();
        return;
      case "run_macro":
        await atem.macroRun(integer("macro"));
        return;
      case "set_aux_source":
        await atem.setAuxSource(integer("source", 1), integer("aux", 1) - 1);
        return;
      case "toggle_downstream_key": {
        const key = integer("key", 1) - 1;
        const onAir = atem.state?.video.downstreamKeyers[key]?.onAir ?? false;
        await atem.setDownstreamKeyOnAir(!onAir, key);
        return;
      }
      default:
        throw new Error(`Unknown ATEM action: ${payload.actionId}`);
    }
  }

  private async ensureProPresenterConnection(): Promise<void> {
    if (!this.propresenter?.host) {
      return;
    }

    const effectivePort =
      this.propresenter.port ?? this.propresenter.apiPort ?? 1025;
    const target = `propresenter:${this.propresenter.host}:${effectivePort}`;
    if (this.ppConnections.has(target)) return;

    await this.connectProPresenter(target, {
      host: this.propresenter.host,
      port: effectivePort,
      apiPort: this.propresenter.apiPort,
      password: this.propresenter.password,
    });
  }

  private async connectProPresenter(
    target: string,
    settings?: Record<string, unknown>,
  ): Promise<void> {
    const existing = this.ppConnections.get(target);
    if (existing) {
      await existing.waitUntilReady();
      return;
    }

    const [fallbackHost, fallbackPort] = target.split(":").slice(-2);
    const ppHost = (settings?.host as string) || fallbackHost;
    const ppPortRaw = settings?.port ?? settings?.apiPort ?? fallbackPort;
    const ppPort = Number.parseInt(String(ppPortRaw || ""), 10);
    const apiPortRaw =
      settings?.apiPort ?? settings?.api_port ?? settings?.["api-port"];
    const ppApiPort = Number.parseInt(String(apiPortRaw || ""), 10);
    if (!ppHost || !Number.isFinite(ppPort) || ppPort <= 0) {
      throw new Error("ProPresenter host and port are required");
    }

    const password = (settings?.password as string) || "";
    const pp = new ProPresenterBridge({
      host: ppHost,
      port: ppPort,
      apiPort:
        Number.isFinite(ppApiPort) && ppApiPort > 0 ? ppApiPort : undefined,
      password,
      onSlideChange: (data) => {
        if (!data) {
          console.log("[pp-bridge] Clearing forwarded slide");
          this.send({
            type: "device-event",
            target,
            eventName: "slide",
            data: "null",
          });
          return;
        }
        const text = typeof data.text === "string" ? data.text : "";
        console.log(
          `[pp-bridge] Forwarding slide: ${text.slice(0, 80).replace(/\s+/g, " ")}`,
        );
        this.send({
          type: "device-event",
          target,
          eventName: "slide",
          data: JSON.stringify(data),
        });
      },
      onStatusChange: (connected) => {
        this.send({ type: "device-status", target, connected });
      },
    });
    this.ppConnections.set(target, pp);
    pp.connect();
    try {
      await pp.waitUntilReady();
    } catch (error) {
      pp.disconnect();
      this.ppConnections.delete(target);
      throw error;
    }
  }

  private async executeTcpCommand(
    target: string,
    command: string,
  ): Promise<string> {
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

  private async executeOscCommand(
    target: string,
    command: string,
  ): Promise<void> {
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

  private async executeUdpCommand(
    target: string,
    command: string,
  ): Promise<void> {
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

  private async executeHttpCommand(
    target: string,
    command: string,
  ): Promise<string> {
    const settings = this.httpDeviceSettings.get(target) ?? {};
    const authToken = settings.authToken as string | undefined;

    const trimmed = command.trim();
    const methodMatch = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : "GET";
    const remainder = methodMatch
      ? trimmed.slice(methodMatch[0].length)
      : trimmed;
    const spaceIdx = remainder.indexOf(" ");
    const path = spaceIdx > 0 ? remainder.slice(0, spaceIdx) : remainder;
    const body = spaceIdx > 0 ? remainder.slice(spaceIdx + 1) : undefined;

    const baseUrl = /^https?:\/\//i.test(target)
      ? target.replace(/\/+$/, "")
      : `http://${target.replace(/\/+$/, "")}`;
    const url = `${baseUrl}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }

    return text;
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
    const targets = connectedBridgeTargets(
      this.tcpConnections.keys(),
      this.udpConnections.keys(),
      this.ppConnections.keys(),
      this.atemConnections.keys(),
      this.httpDeviceSettings.keys(),
    );
    this.send({
      type: "bridge-status",
      version: BRIDGE_VERSION,
      devices: targets.length,
      targets,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
    });
  }
}
