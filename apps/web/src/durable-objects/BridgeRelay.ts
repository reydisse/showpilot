import { DurableObject } from "cloudflare:workers";
import { getActiveRundownRelayTarget } from "@/lib/active-rundown-relay";
import type { BridgeDeviceProtocol } from "@/lib/device-modules/types";
import {
  hasLivePermissionAuthority,
  type LiveSessionAuthorityClaim,
} from "@/lib/live-rundown-authority.server";

/**
 * BridgeRelay — mediates between browser clients and the ShowPilot Bridge agent.
 *
 * Two types of WebSocket connections:
 * - Bridge agent (one per org, connects with role=bridge)
 * - Browser clients (multiple, connect with role=client)
 *
 * Flow: Browser sends command → DO forwards to bridge → bridge executes → response flows back
 */

interface BridgeMessage {
  type: string;
  [key: string]: unknown;
}

export type BridgeDispatchMessage =
  | {
      type: "command";
      id: string;
      protocol: BridgeDeviceProtocol;
      target: string;
      command: string;
    }
  | {
      type: "connect-device";
      protocol: BridgeDeviceProtocol;
      target: string;
      settings: Record<string, unknown>;
    }
  | {
      type: "disconnect-device";
      target: string;
    };

type BridgeRelayEnv = Pick<Env, "RUNDOWN_RELAY" | "TIMECODE_RELAY" | "DB">;
type BridgeRelayRuntimeEnv = BridgeRelayEnv & { BETTER_AUTH_SECRET?: string };

interface SocketAttachment {
  role: "bridge" | "client";
  orgId: string;
  bridgeInfo?: BridgeRelayStatusInfo;
  bridgeKey?: string;
  authClaim?: LiveSessionAuthorityClaim;
}

export interface BridgeDeviceEventSnapshot {
  eventName: string;
  data: string;
  receivedAt: number;
}

interface BridgeRelayStatusInfo {
  version?: string;
  devices?: number;
  uptime?: number;
  connectedTargets: string[];
  deviceEvents?: Record<string, BridgeDeviceEventSnapshot>;
}

export interface BridgeRelayStatus extends BridgeRelayStatusInfo {
  bridgeOnline: boolean;
  clientCount: number;
}

interface PendingDispatch {
  resolve: (result: BridgeDispatchResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingClientCommand {
  socket: WebSocket;
  clientId: string;
}

export interface BridgeDispatchResult {
  success: boolean;
  response?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBridgeInfo(value: unknown): BridgeRelayStatusInfo | null {
  if (!isRecord(value) || !Array.isArray(value.connectedTargets)) return null;
  const connectedTargets = value.connectedTargets.filter((target): target is string => typeof target === "string");
  const deviceEvents: Record<string, BridgeDeviceEventSnapshot> = {};
  if (isRecord(value.deviceEvents)) {
    for (const [target, event] of Object.entries(value.deviceEvents)) {
      if (
        isRecord(event)
        && typeof event.eventName === "string"
        && typeof event.data === "string"
        && typeof event.receivedAt === "number"
      ) {
        deviceEvents[target] = {
          eventName: event.eventName,
          data: event.data,
          receivedAt: event.receivedAt,
        };
      }
    }
  }
  return {
    version: typeof value.version === "string" ? value.version : undefined,
    devices: typeof value.devices === "number" ? value.devices : undefined,
    uptime: typeof value.uptime === "number" ? value.uptime : undefined,
    connectedTargets,
    deviceEvents,
  };
}

function parseSocketAttachment(value: unknown): SocketAttachment | null {
  if (!isRecord(value) || (value.role !== "bridge" && value.role !== "client") || typeof value.orgId !== "string") {
    return null;
  }
  const bridgeInfo = value.bridgeInfo === undefined ? undefined : parseBridgeInfo(value.bridgeInfo);
  if (value.bridgeInfo !== undefined && !bridgeInfo) return null;
  return {
    role: value.role,
    orgId: value.orgId,
    bridgeInfo: bridgeInfo ?? undefined,
    bridgeKey: typeof value.bridgeKey === "string" ? value.bridgeKey : undefined,
    authClaim: isRecord(value.authClaim)
      && typeof value.authClaim.userId === "string"
      && typeof value.authClaim.sessionId === "string"
      && typeof value.authClaim.orgId === "string"
      ? {
          userId: value.authClaim.userId,
          sessionId: value.authClaim.sessionId,
          orgId: value.authClaim.orgId,
        }
      : undefined,
  };
}

export class BridgeRelay extends DurableObject<BridgeRelayRuntimeEnv> {
  private bridgeWs: WebSocket | null = null;
  private clientSessions: Set<WebSocket> = new Set();
  private bridgeOnline = false;
  private bridgeInfo: BridgeRelayStatusInfo = { connectedTargets: [], deviceEvents: {} };
  private bridgeKey: string | null = null;
  private orgId = "";
  private pendingCommands = new Map<string, PendingDispatch>();
  private pendingConnections = new Map<string, PendingDispatch>();
  private pendingClientCommands = new Map<string, PendingClientCommand>();

  constructor(ctx: DurableObjectState, env: BridgeRelayEnv) {
    super(ctx, env);

    for (const ws of ctx.getWebSockets()) {
      const attachment = parseSocketAttachment(ws.deserializeAttachment?.());
      if (!attachment) continue;

      if (!this.orgId && attachment.orgId) {
        this.orgId = attachment.orgId;
      }

      if (attachment.role === "bridge") {
        this.bridgeWs = ws;
        this.bridgeKey = attachment.bridgeKey ?? null;
        this.bridgeOnline = true;
        if (attachment.bridgeInfo) this.bridgeInfo = attachment.bridgeInfo;
      } else {
        this.clientSessions.add(ws);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestedOrgId = url.searchParams.get("orgId") ?? "";
    if (this.orgId && requestedOrgId && requestedOrgId !== this.orgId) {
      return new Response("Organization mismatch", { status: 403 });
    }
    if (!this.orgId) this.orgId = requestedOrgId;
    if (!this.orgId) return new Response("Organization is required", { status: 400 });

    if (url.pathname === "/internal/purge-org" && request.method === "POST") {
      if (!this.env.BETTER_AUTH_SECRET || request.headers.get("x-showpilot-internal-secret") !== this.env.BETTER_AUTH_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, "Organization deleted");
      this.failPendingDispatches("Organization deleted");
      this.failPendingClientCommands("Organization deleted");
      await this.ctx.storage.deleteAll();
      this.bridgeWs = null;
      this.clientSessions.clear();
      this.bridgeOnline = false;
      this.bridgeKey = null;
      this.bridgeInfo = { connectedTargets: [], deviceEvents: {} };
      return Response.json({ ok: true });
    }

    if (url.pathname === "/ws") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      try {
        const role = url.searchParams.get("role") ?? "client";
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        const attachment: SocketAttachment = {
          role: role === "bridge" ? "bridge" : "client",
          orgId: this.orgId,
          ...(role === "bridge"
            ? { bridgeKey: url.searchParams.get("authBridgeKey") ?? url.searchParams.get("key") ?? undefined }
            : {
                authClaim: this.readAuthorityClaim(url) ?? undefined,
              }),
        };

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment?.(attachment);

        if (role === "bridge") {
          // Bridge agent connecting
          if (this.bridgeWs) {
            this.failPendingDispatches("Venue Bridge was replaced");
            // A deliberate replacement must not become a reconnect war. The
            // displaced installation treats 4410 as a terminal takeover and
            // remains stopped until an operator starts it again.
            try {
              this.bridgeWs.close(4410, "Venue Bridge replaced by another installation");
            } catch {}
          }
          this.bridgeWs = server;
          this.bridgeKey = attachment.bridgeKey ?? null;
          this.bridgeOnline = true;
          this.bridgeInfo = { connectedTargets: [], deviceEvents: {} };
          // Notify all clients bridge is online
          await this.broadcastToClients(
            JSON.stringify({
              type: "bridge-status",
              online: true,
              ...this.bridgeInfo,
            })
          );
        } else {
          // Browser client connecting
          this.clientSessions.add(server);
          // Send current bridge status
          server.send(
            JSON.stringify({
              type: "bridge-status",
              online: this.bridgeOnline,
              ...this.bridgeInfo,
            })
          );
        }

        return new Response(null, { status: 101, webSocket: client });
      } catch (err) {
        console.error("[BridgeRelay] websocket setup failed", err);
        return new Response("Bridge websocket failed", { status: 500 });
      }
    }

    if (url.pathname === "/status") {
      return Response.json(this.getBridgeStatus());
    }

    return new Response("Not found", { status: 404 });
  }

  getBridgeStatus(): BridgeRelayStatus {
    return {
      bridgeOnline: this.bridgeOnline,
      clientCount: this.clientSessions.size,
      ...this.bridgeInfo,
    };
  }

  /** Internal Worker RPC used by permission-checked native device controls. */
  async dispatchBridgeMessage(message: BridgeDispatchMessage): Promise<BridgeDispatchResult> {
    const bridgeSocket = this.bridgeWs;
    if (!bridgeSocket || !this.bridgeOnline) return { success: false, error: "Venue Bridge is offline" };

    if (message.type === "disconnect-device") {
      try {
        bridgeSocket.send(JSON.stringify(message));
        return { success: true };
      } catch {
        return { success: false, error: "Venue Bridge disconnected" };
      }
    }

    const key = message.type === "command"
      ? typeof message.id === "string" ? message.id : ""
      : typeof message.target === "string" ? message.target : "";
    if (!key) return { success: false, error: "Bridge operation is missing an identifier" };
    const pending = message.type === "command" ? this.pendingCommands : this.pendingConnections;
    if (pending.has(key)) return { success: false, error: "A matching device operation is already running" };

    return new Promise<BridgeDispatchResult>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        resolve({ success: false, error: message.type === "command" ? "Device command timed out" : "Device connection timed out" });
      }, message.type === "command" ? 10_000 : 8_000);
      pending.set(key, { resolve, timer });
      try {
        bridgeSocket.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        pending.delete(key);
        resolve({ success: false, error: "Venue Bridge disconnected" });
      }
    });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const parsed: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      if (!isRecord(parsed) || typeof parsed.type !== "string") return;
      const msg: BridgeMessage = { ...parsed, type: parsed.type };

      if (ws === this.bridgeWs) {
        if (this.bridgeKey && !(await this.bridgeKeyIsCurrent())) {
          ws.close(4403, "Venue Bridge key changed");
          this.webSocketClose(ws);
          return;
        }
        // Message from bridge → forward to clients
        void this.handleBridgeMessage(msg);
      } else {
        const attachment = parseSocketAttachment(ws.deserializeAttachment?.());
        if (
          attachment?.authClaim
          && !(await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "devices:access"))
        ) {
          ws.close(4403, "Device access changed");
          this.clientSessions.delete(ws);
          return;
        }
        // Message from browser client → forward to bridge
        this.handleClientMessage(msg, ws);
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(ws: WebSocket) {
    if (ws === this.bridgeWs) {
      this.bridgeWs = null;
      this.bridgeKey = null;
      this.bridgeOnline = false;
      this.bridgeInfo = { connectedTargets: [], deviceEvents: {} };
      this.failPendingDispatches("Venue Bridge disconnected");
      this.failPendingClientCommands("Venue Bridge disconnected");
      void this.clearPreviewSlide();
      void this.stopBridgeTimecode();
      void this.broadcastToClients(JSON.stringify({
        type: "bridge-status",
        online: false,
      }));
    } else {
      this.clientSessions.delete(ws);
      for (const [operationId, owner] of this.pendingClientCommands) {
        if (owner.socket === ws) this.pendingClientCommands.delete(operationId);
      }
    }
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }

  // ─── Message Routing ────────────────────────────────────

  private async handleBridgeMessage(msg: BridgeMessage): Promise<void> {
    switch (msg.type) {
      case "bridge-status":
        this.bridgeInfo = {
          version: typeof msg.version === "string" ? msg.version : undefined,
          devices: typeof msg.devices === "number" ? msg.devices : undefined,
          uptime: typeof msg.uptime === "number" ? msg.uptime : undefined,
          connectedTargets: Array.isArray(msg.targets)
            ? msg.targets.filter((target): target is string => typeof target === "string")
            : this.bridgeInfo.connectedTargets,
          deviceEvents: this.bridgeInfo.deviceEvents,
        };
        this.serializeBridgeAttachment();
        await this.broadcastToClients(JSON.stringify({
          type: "bridge-status",
          online: true,
          ...this.bridgeInfo,
        }));
        break;

      case "command-response":
        if (typeof msg.id === "string") {
          const pending = this.pendingCommands.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommands.delete(msg.id);
            pending.resolve({
              success: msg.success === true,
              response: typeof msg.response === "string" ? msg.response : undefined,
              error: typeof msg.error === "string" ? msg.error : undefined,
            });
            break;
          }
          const owner = this.pendingClientCommands.get(msg.id);
          if (owner) {
            this.pendingClientCommands.delete(msg.id);
            try {
              owner.socket.send(JSON.stringify({ ...msg, id: owner.clientId }));
            } catch {
              this.clientSessions.delete(owner.socket);
            }
          }
        }
        break;

      case "device-event":
        if (msg.eventName === "slide" && typeof msg.data === "string") {
          void this.pushPreviewSlide(msg.data);
        }
        if (
          msg.type === "device-event" &&
          typeof msg.target === "string" &&
          typeof msg.eventName === "string" &&
          typeof msg.data === "string"
        ) {
          this.bridgeInfo = {
            ...this.bridgeInfo,
            deviceEvents: {
              ...this.bridgeInfo.deviceEvents,
              [msg.target]: {
                eventName: msg.eventName,
                data: msg.data,
                receivedAt: Date.now(),
              },
            },
          };
          this.serializeBridgeAttachment();
        }
        // Unsolicited device events are shared venue state and reach every
        // operator. Command replies above are deliberately point-to-point.
        await this.broadcastToClients(JSON.stringify(msg));
        break;

      case "device-status":
        if (typeof msg.target === "string") {
          const targets = new Set(this.bridgeInfo.connectedTargets);
          if (msg.connected === true) targets.add(msg.target);
          else targets.delete(msg.target);
          const deviceEvents = { ...this.bridgeInfo.deviceEvents };
          if (msg.connected !== true) delete deviceEvents[msg.target];
          this.bridgeInfo = { ...this.bridgeInfo, connectedTargets: [...targets].sort(), devices: targets.size, deviceEvents };
          this.serializeBridgeAttachment();
          const pending = this.pendingConnections.get(msg.target);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingConnections.delete(msg.target);
            pending.resolve({
              success: msg.connected === true,
              error: msg.connected === true ? undefined : "Venue Bridge could not connect to the device",
            });
          }
        }
        if (
          msg.type === "device-status" &&
          msg.connected === false &&
          typeof msg.target === "string" &&
          msg.target.startsWith("propresenter:")
        ) {
          void this.clearPreviewSlide();
        }
        // Forward directly to all browser clients
        await this.broadcastToClients(JSON.stringify(msg));
        break;

      case "pong":
        // Bridge responding to keepalive
        break;

      case "timecode-feed":
        await this.pushTimecode(msg);
        break;
    }
  }

  private handleClientMessage(msg: BridgeMessage, clientWs: WebSocket): void {
    if (!this.bridgeWs || !this.bridgeOnline) {
      // No bridge connected — can't forward
      if (msg.type === "command" && msg.id) {
        clientWs.send(JSON.stringify({
          type: "command-response",
          id: msg.id,
          success: false,
          error: "Bridge is offline",
        }));
      }
      return;
    }

    switch (msg.type) {
      case "command": {
        if (typeof msg.id !== "string" || !msg.id) return;
        const operationId = `client_${crypto.randomUUID()}`;
        this.pendingClientCommands.set(operationId, { socket: clientWs, clientId: msg.id });
        try {
          this.bridgeWs.send(JSON.stringify({ ...msg, id: operationId }));
        } catch {
          this.pendingClientCommands.delete(operationId);
          try {
            clientWs.send(JSON.stringify({
              type: "command-response",
              id: msg.id,
              success: false,
              error: "Venue Bridge disconnected",
            }));
          } catch {}
        }
        break;
      }
      case "connect-device":
        // Forward to bridge
        try {
          this.bridgeWs.send(JSON.stringify(msg));
        } catch {
          // Bridge disconnected
        }
        break;

      case "disconnect-device":
        // Closing a control panel detaches that browser only. Physical venue
        // connections remain owned by the Bridge so another operator is not
        // disconnected mid-show. Deliberate venue-wide disconnects use the
        // internal dispatch API.
        break;

      case "ping":
        try {
          this.bridgeWs.send(JSON.stringify({ type: "ping" }));
        } catch {}
        break;
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  private failPendingDispatches(error: string): void {
    for (const pending of [...this.pendingCommands.values(), ...this.pendingConnections.values()]) {
      clearTimeout(pending.timer);
      pending.resolve({ success: false, error });
    }
    this.pendingCommands.clear();
    this.pendingConnections.clear();
  }

  private failPendingClientCommands(error: string): void {
    for (const owner of this.pendingClientCommands.values()) {
      try {
        owner.socket.send(JSON.stringify({
          type: "command-response",
          id: owner.clientId,
          success: false,
          error,
        }));
      } catch {}
    }
    this.pendingClientCommands.clear();
  }

  private async broadcastToClients(data: string): Promise<void> {
    for (const ws of [...this.clientSessions]) {
      const attachment = parseSocketAttachment(ws.deserializeAttachment?.());
      if (
        attachment?.authClaim
        && !(await hasLivePermissionAuthority(this.env.DB, attachment.authClaim, "devices:access"))
      ) {
        ws.close(4403, "Device access changed");
        this.clientSessions.delete(ws);
        continue;
      }
      try {
        ws.send(data);
      } catch {
        this.clientSessions.delete(ws);
      }
    }
  }

  private readAuthorityClaim(url: URL): LiveSessionAuthorityClaim | null {
    const userId = url.searchParams.get("authUserId")?.trim();
    const sessionId = url.searchParams.get("authSessionId")?.trim();
    if (!userId || !sessionId || !this.orgId) return null;
    return { userId, sessionId, orgId: this.orgId };
  }

  private serializeBridgeAttachment(): void {
    this.bridgeWs?.serializeAttachment?.({
      role: "bridge",
      orgId: this.orgId,
      bridgeInfo: this.bridgeInfo,
      ...(this.bridgeKey ? { bridgeKey: this.bridgeKey } : {}),
    } satisfies SocketAttachment);
  }

  private async bridgeKeyIsCurrent(): Promise<boolean> {
    if (!this.bridgeKey || !this.orgId) return false;
    const setting = await this.env.DB.prepare(
      "SELECT value FROM app_setting WHERE orgId = ? AND key = 'api-key' LIMIT 1",
    ).bind(this.orgId).first<{ value: string | null }>();
    const expected = setting?.value ?? "";
    if (!expected) return false;
    const encoder = new TextEncoder();
    const [leftBuffer, rightBuffer] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(this.bridgeKey)),
      crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    ]);
    const left = new Uint8Array(leftBuffer);
    const right = new Uint8Array(rightBuffer);
    let mismatch = left.length ^ right.length;
    for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
    return mismatch === 0;
  }

  private async pushPreviewSlide(data: string): Promise<void> {
    if (!this.orgId) return;

    try {
      const parsed: unknown = JSON.parse(data);
      if (!isRecord(parsed)) {
        await this.clearPreviewSlide();
        return;
      }
      const slide = parsed;

      const payload = {
        text: String(slide.text ?? ""),
        notes: String(slide.notes ?? ""),
        presentationName: String(slide.presentationName ?? slide.pn ?? ""),
        isScripture: Boolean(slide.isScripture ?? slide.scripture ?? false),
        updatedAt: Date.now(),
      };

      const target = await getActiveRundownRelayTarget(this.env.DB, this.orgId);
      const rdId = this.env.RUNDOWN_RELAY.idFromName(target.key);
      const rdStub = this.env.RUNDOWN_RELAY.get(rdId);
      await rdStub.fetch(
        new Request(`https://rundown.local/command?orgId=${encodeURIComponent(this.orgId)}&serviceDate=${encodeURIComponent(target.serviceDate)}${target.showId ? `&showId=${encodeURIComponent(target.showId)}` : ""}&access=control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "pp-preview",
            payload: { slide: payload, outputEnabled: target.ppOutputEnabled },
          }),
        })
      );
    } catch (err) {
      console.error("[BridgeRelay] failed to push preview slide", err);
    }
  }

  private async clearPreviewSlide(): Promise<void> {
    if (!this.orgId) return;

    try {
      const target = await getActiveRundownRelayTarget(this.env.DB, this.orgId);
      const rdId = this.env.RUNDOWN_RELAY.idFromName(target.key);
      const rdStub = this.env.RUNDOWN_RELAY.get(rdId);
      await rdStub.fetch(
        new Request(`https://rundown.local/command?orgId=${encodeURIComponent(this.orgId)}&serviceDate=${encodeURIComponent(target.serviceDate)}${target.showId ? `&showId=${encodeURIComponent(target.showId)}` : ""}&access=control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "pp-preview",
            payload: { slide: null, outputEnabled: target.ppOutputEnabled },
          }),
        })
      );
    } catch (err) {
      console.error("[BridgeRelay] failed to clear preview slide", err);
    }
  }

  private async pushTimecode(message: BridgeMessage): Promise<void> {
    if (!this.orgId || !this.env.TIMECODE_RELAY || !isRecord(message.timecode) || !isRecord(message.format)) return;
    const relay = this.env.TIMECODE_RELAY.get(this.env.TIMECODE_RELAY.idFromName(this.orgId));
    await relay.fetch(new Request(`https://timecode.local/command?orgId=${encodeURIComponent(this.orgId)}&access=write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "feed-tc",
        payload: {
          timecode: message.timecode,
          format: message.format,
          totalFrames: message.totalFrames,
        },
      }),
    }));
  }

  private async stopBridgeTimecode(): Promise<void> {
    if (!this.orgId || !this.env.TIMECODE_RELAY) return;
    const relay = this.env.TIMECODE_RELAY.get(this.env.TIMECODE_RELAY.idFromName(this.orgId));
    await relay.fetch(new Request(`https://timecode.local/command?orgId=${encodeURIComponent(this.orgId)}&access=write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "bridge-disconnected" }),
    }));
  }
}
