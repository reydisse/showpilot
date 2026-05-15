import { DurableObject } from "cloudflare:workers";

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

interface Env {
  RUNDOWN_RELAY: DurableObjectNamespace;
}

interface SocketAttachment {
  role: "bridge" | "client";
  orgId: string;
}

export class BridgeRelay extends DurableObject<Env> {
  private bridgeWs: WebSocket | null = null;
  private clientSessions: Set<WebSocket> = new Set();
  private bridgeOnline = false;
  private bridgeInfo: { version?: string; devices?: number; uptime?: number } = {};
  private orgId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    for (const ws of ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment?.() as SocketAttachment | null;
      if (!attachment) continue;

      if (!this.orgId && attachment.orgId) {
        this.orgId = attachment.orgId;
      }

      if (attachment.role === "bridge") {
        this.bridgeWs = ws;
        this.bridgeOnline = true;
      } else {
        this.clientSessions.add(ws);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;

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
        };

        this.ctx.acceptWebSocket(server);
        server.serializeAttachment?.(attachment);

        if (role === "bridge") {
          // Bridge agent connecting
          if (this.bridgeWs) {
            // Disconnect old bridge
            try {
              this.bridgeWs.close();
            } catch {}
          }
          this.bridgeWs = server;
          this.bridgeOnline = true;
          // Notify all clients bridge is online
          this.broadcastToClients(
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
      return Response.json({
        bridgeOnline: this.bridgeOnline,
        clientCount: this.clientSessions.size,
        ...this.bridgeInfo,
      });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(data as string) as BridgeMessage;

      if (ws === this.bridgeWs) {
        // Message from bridge → forward to clients
        this.handleBridgeMessage(msg);
      } else {
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
      this.bridgeOnline = false;
      this.clearPreviewSlide();
      this.broadcastToClients(JSON.stringify({
        type: "bridge-status",
        online: false,
      }));
    } else {
      this.clientSessions.delete(ws);
    }
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }

  // ─── Message Routing ────────────────────────────────────

  private handleBridgeMessage(msg: BridgeMessage): void {
    switch (msg.type) {
      case "bridge-status":
        this.bridgeInfo = {
          version: msg.version as string | undefined,
          devices: msg.devices as number | undefined,
          uptime: msg.uptime as number | undefined,
        };
        this.broadcastToClients(JSON.stringify({
          type: "bridge-status",
          online: true,
          ...this.bridgeInfo,
        }));
        break;

        case "command-response":
        case "device-event":
          if (msg.eventName === "slide") {
            this.pushPreviewSlide(msg.data as string);
          }
          break;
        case "device-status":
        if (
          msg.type === "device-status" &&
          msg.connected === false &&
          typeof msg.target === "string" &&
          msg.target.startsWith("propresenter:")
        ) {
          void this.clearPreviewSlide();
        }
        // Forward directly to all browser clients
        this.broadcastToClients(JSON.stringify(msg));
        break;

      case "pong":
        // Bridge responding to keepalive
        break;
    }
  }

  private handleClientMessage(msg: BridgeMessage, _clientWs: WebSocket): void {
    if (!this.bridgeWs || !this.bridgeOnline) {
      // No bridge connected — can't forward
      if (msg.type === "command" && msg.id) {
        _clientWs.send(JSON.stringify({
          type: "command-response",
          id: msg.id,
          success: false,
          error: "Bridge is offline",
        }));
      }
      return;
    }

    switch (msg.type) {
      case "command":
      case "connect-device":
      case "disconnect-device":
        // Forward to bridge
        try {
          this.bridgeWs.send(JSON.stringify(msg));
        } catch {
          // Bridge disconnected
        }
        break;

      case "ping":
        try {
          this.bridgeWs.send(JSON.stringify({ type: "ping" }));
        } catch {}
        break;
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  private broadcastToClients(data: string): void {
    for (const ws of this.clientSessions) {
      try {
        ws.send(data);
      } catch {
        this.clientSessions.delete(ws);
      }
    }
  }

  private async pushPreviewSlide(data: string): Promise<void> {
    if (!this.orgId) return;

    try {
      const slide = JSON.parse(data) as Record<string, unknown> | null;
      if (!slide) {
        await this.clearPreviewSlide();
        return;
      }

      const payload = {
        text: String(slide.text ?? ""),
        notes: String(slide.notes ?? ""),
        presentationName: String(slide.presentationName ?? slide.pn ?? ""),
        isScripture: Boolean(slide.isScripture ?? slide.scripture ?? false),
        updatedAt: Date.now(),
      };

      const env = this.env as unknown as Env;
      const rdId = env.RUNDOWN_RELAY.idFromName(this.orgId);
      const rdStub = env.RUNDOWN_RELAY.get(rdId);
      await rdStub.fetch(
        new Request(`https://rundown.local/command?orgId=${encodeURIComponent(this.orgId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pp-preview", payload: { slide: payload } }),
        })
      );
    } catch (err) {
      console.error("[BridgeRelay] failed to push preview slide", err);
    }
  }

  private async clearPreviewSlide(): Promise<void> {
    if (!this.orgId) return;

    try {
      const env = this.env as unknown as Env;
      const rdId = env.RUNDOWN_RELAY.idFromName(this.orgId);
      const rdStub = env.RUNDOWN_RELAY.get(rdId);
      await rdStub.fetch(
        new Request(`https://rundown.local/command?orgId=${encodeURIComponent(this.orgId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pp-preview", payload: { slide: null } }),
        })
      );
    } catch (err) {
      console.error("[BridgeRelay] failed to clear preview slide", err);
    }
  }
}
