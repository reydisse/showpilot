import { DurableObject } from "cloudflare:workers";
import type {
  TimecodeState,
  TimecodeFormat,
  TimecodeValue,
  AutomationEvent,
  TimecodeCommand,
  TimecodeWsMessage,
  AutomationActionType,
} from "@/types/timecode";
import { timecodeToFrames, timecodeToString } from "@/lib/timecode";

interface Env {
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
  RUNDOWN_RELAY: DurableObjectNamespace;
}

export class TimecodeRelay extends DurableObject {
  private sessions: Set<WebSocket> = new Set();
  private state: TimecodeState = {
    timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
    display: "00:00:00:00",
    source: "internal-freerun",
    format: { frameRate: 30, dropFrame: "ndf" },
    running: false,
    serverTime: Date.now(),
    totalFrames: 0,
  };
  private events: AutomationEvent[] = [];
  private orgId = "";

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract orgId from query param or path
    this.orgId = url.searchParams.get("orgId") ?? this.orgId;

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      this.sessions.add(server);

      // Hydrate
      const hydrate: TimecodeWsMessage = {
        type: "hydrate",
        state: this.state,
        events: this.events,
      };
      server.send(JSON.stringify(hydrate));

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(this.state);
    }

    if (url.pathname === "/events") {
      return Response.json(this.events);
    }

    if (url.pathname === "/command" && request.method === "POST") {
      const body = (await request.json()) as {
        action: TimecodeCommand;
        payload?: Record<string, unknown>;
      };
      await this.handleCommand(body.action, body.payload);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const msg = JSON.parse(data as string) as TimecodeWsMessage;
      if (msg.type === "command") {
        this.handleCommand(msg.action, msg.payload);
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  webSocketError(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  // ─── Command Handler ────────────────────────────────────

  private async handleCommand(
    action: TimecodeCommand,
    payload?: Record<string, unknown>
  ): Promise<void> {
    switch (action) {
      case "start":
        this.state.running = true;
        this.broadcastState();
        break;

      case "stop":
        this.state.running = false;
        this.broadcastState();
        break;

      case "feed-tc": {
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        const format = (payload.format as TimecodeFormat) ?? this.state.format;
        const totalFrames =
          (payload.totalFrames as number) ?? timecodeToFrames(tc, format);

        this.state.timecode = tc;
        this.state.totalFrames = totalFrames;
        this.state.display = timecodeToString(tc, format.dropFrame === "df");
        this.state.format = format;
        this.state.running = true;
        this.state.serverTime = Date.now();

        // Evaluate automation events
        await this.evaluateEvents(totalFrames);

        this.broadcastState();
        break;
      }

      case "set-timecode": {
        if (!payload) break;
        const tc = payload.timecode as TimecodeValue;
        this.state.timecode = tc;
        this.state.totalFrames = timecodeToFrames(tc, this.state.format);
        this.state.display = timecodeToString(
          tc,
          this.state.format.dropFrame === "df"
        );
        this.state.serverTime = Date.now();
        this.broadcastState();
        break;
      }

      case "set-source":
        if (payload?.source) {
          this.state.source = payload.source as TimecodeState["source"];
        }
        this.broadcastState();
        break;

      case "set-format":
        if (payload?.format) {
          this.state.format = payload.format as TimecodeFormat;
        }
        this.broadcastState();
        break;

      case "add-event": {
        if (!payload) break;
        const event = payload as unknown as AutomationEvent;
        event.id = event.id || crypto.randomUUID();
        event.fired = false;
        event.toleranceFrames = event.toleranceFrames ?? 2;
        event.triggerFrame = timecodeToFrames(
          event.triggerTimecode,
          this.state.format
        );
        this.events.push(event);
        this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
        this.broadcastEvents();
        break;
      }

      case "update-event": {
        if (!payload?.id) break;
        const idx = this.events.findIndex(
          (e) => e.id === (payload.id as string)
        );
        if (idx >= 0) {
          Object.assign(this.events[idx], payload.updates ?? payload);
          // Recalculate triggerFrame if timecode changed
          if ((payload.updates as Record<string, unknown>)?.triggerTimecode || payload.triggerTimecode) {
            this.events[idx].triggerFrame = timecodeToFrames(
              this.events[idx].triggerTimecode,
              this.state.format
            );
          }
          this.events.sort((a, b) => a.triggerFrame - b.triggerFrame);
          this.broadcastEvents();
        }
        break;
      }

      case "remove-event": {
        if (!payload?.id) break;
        this.events = this.events.filter(
          (e) => e.id !== (payload.id as string)
        );
        this.broadcastEvents();
        break;
      }

      case "reset-events":
        for (const event of this.events) {
          event.fired = false;
        }
        this.broadcastEvents();
        break;
    }
  }

  // ─── Automation Engine ──────────────────────────────────

  private async evaluateEvents(totalFrames: number): Promise<void> {
    for (const event of this.events) {
      if (event.fired) continue;

      const diff = Math.abs(totalFrames - event.triggerFrame);
      if (diff <= event.toleranceFrames) {
        event.fired = true;
        await this.executeEventAction(event);
        this.broadcastEventFired(event);
      }
    }
  }

  private async executeEventAction(event: AutomationEvent): Promise<void> {
    const env = this.env as unknown as Env;

    try {
      switch (event.action) {
        case "lower-third-show": {
          const ltId = env.LOWER_THIRDS_RELAY.idFromName(this.orgId);
          const ltStub = env.LOWER_THIRDS_RELAY.get(ltId);
          await ltStub.fetch(
            new Request("https://internal/trigger", {
              method: "POST",
              body: JSON.stringify(event.payload),
            })
          );
          break;
        }

        case "lower-third-clear": {
          const ltId = env.LOWER_THIRDS_RELAY.idFromName(this.orgId);
          const ltStub = env.LOWER_THIRDS_RELAY.get(ltId);
          await ltStub.fetch(
            new Request("https://internal/clear", { method: "POST" })
          );
          break;
        }

        case "rundown-advance": {
          const rdId = env.RUNDOWN_RELAY.idFromName(this.orgId);
          const rdStub = env.RUNDOWN_RELAY.get(rdId);
          await rdStub.fetch(
            new Request("https://internal/command", {
              method: "POST",
              body: JSON.stringify({ action: "timer-next" }),
            })
          );
          break;
        }

        case "rundown-start-item": {
          const rdId = env.RUNDOWN_RELAY.idFromName(this.orgId);
          const rdStub = env.RUNDOWN_RELAY.get(rdId);
          await rdStub.fetch(
            new Request("https://internal/command", {
              method: "POST",
              body: JSON.stringify({
                action: "timer-start",
                payload: event.payload,
              }),
            })
          );
          break;
        }

        case "device-action":
          // Device actions are forwarded to clients who execute them
          // via their local device module connections
          // The event-fired broadcast carries the action info
          break;

        case "custom-webhook": {
          const url = event.payload.url as string;
          if (url) {
            await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: event.label,
                timecode: this.state.display,
                payload: event.payload,
                firedAt: Date.now(),
              }),
            });
          }
          break;
        }
      }
    } catch (err) {
      console.error(
        `[TimecodeRelay] Failed to execute event "${event.label}":`,
        err
      );
    }
  }

  // ─── Broadcasting ───────────────────────────────────────

  private broadcastState(): void {
    const msg: TimecodeWsMessage = { type: "tc-update", state: this.state };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcastEvents(): void {
    const msg: TimecodeWsMessage = {
      type: "events-update",
      events: this.events,
    };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcastEventFired(event: AutomationEvent): void {
    const msg: TimecodeWsMessage = {
      type: "event-fired",
      event,
      firedAt: Date.now(),
    };
    this.broadcast(JSON.stringify(msg));
  }

  private broadcast(data: string): void {
    for (const ws of this.sessions) {
      try {
        ws.send(data);
      } catch {
        this.sessions.delete(ws);
      }
    }
  }
}
