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

export class BridgeRelay extends DurableObject {
  private bridgeWs: WebSocket | null = null;
  private clientSessions: Set<WebSocket> = new Set();
  private bridgeOnline = false;
  private bridgeInfo: { version?: string; devices?: number; uptime?: number } = {};

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") ?? "client";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);

      if (role === "bridge") {
        // Bridge agent connecting
        if (this.bridgeWs) {
          // Disconnect old bridge
          try { this.bridgeWs.close(); } catch {}
        }
        this.bridgeWs = server;
        this.bridgeOnline = true;
        // Notify all clients bridge is online
        this.broadcastToClients(JSON.stringify({
          type: "bridge-status",
          online: true,
          ...this.bridgeInfo,
        }));
      } else {
        // Browser client connecting
        this.clientSessions.add(server);
        // Send current bridge status
        server.send(JSON.stringify({
          type: "bridge-status",
          online: this.bridgeOnline,
          ...this.bridgeInfo,
        }));
      }

      return new Response(null, { status: 101, webSocket: client });
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
      case "device-status":
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
}
