import { DurableObject } from "cloudflare:workers";

export type ItemType =
  | "segment"
  | "song"
  | "prayer"
  | "announcement"
  | "offering"
  | "custom";

export type ItemStatus = "upcoming" | "live" | "complete";

export interface RundownItem {
  id: string;
  title: string;
  type: ItemType;
  duration: number; // ms
  notes: string;
  assignee: string;
  cue: string;
  status: ItemStatus;
  sortOrder: number;
  hardStop: boolean;
  lowerThirdId?: string;
}

export interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number; // ms
  startedAt: number | null; // timestamp
  pausedAt: number | null;
  mode: "count-up" | "count-down";
}

interface RundownState {
  items: RundownItem[];
  timer: TimerState;
}

export class RundownRelay extends DurableObject {
  private state: RundownState = {
    items: [],
    timer: {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    },
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);

      // Hydrate with current state
      server.send(
        JSON.stringify({ type: "hydrate", state: this.getPublicState() })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/state") {
      return Response.json(this.getPublicState());
    }

    if (url.pathname === "/command" && request.method === "POST") {
      const body = (await request.json()) as {
        action: string;
        payload?: Record<string, unknown>;
      };
      this.handleCommand(body.action, body.payload);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    try {
      const parsed = JSON.parse(data as string) as {
        type: string;
        action?: string;
        payload?: Record<string, unknown>;
      };

      if (parsed.type === "ping") {
        // Keepalive — just receiving this prevents hibernation
        return;
      }

      if (parsed.type === "command" && parsed.action) {
        this.handleCommand(parsed.action, parsed.payload);
      }
    } catch {
      // Ignore
    }
  }

  webSocketClose(_ws: WebSocket) {
    // No manual session tracking needed — using ctx.getWebSockets()
  }

  webSocketError(_ws: WebSocket) {
    // No manual session tracking needed
  }

  private handleCommand(
    action: string,
    payload?: Record<string, unknown>
  ) {
    switch (action) {
      case "seed": {
        // Seed DO with DB-loaded state
        // Only accept if DO is empty OR force flag is set (e.g. load template)
        const force = payload?.force as boolean;
        if ((this.state.items.length === 0 || force) && payload?.items) {
          this.state.items = payload.items as RundownItem[];
          const t = payload.timer as TimerState | undefined;
          if (t) {
            this.state.timer = {
              playback: t.playback ?? "stop",
              currentItemId: t.currentItemId ?? null,
              elapsed: t.elapsed ?? 0,
              startedAt: t.startedAt ?? null,
              pausedAt: t.pausedAt ?? null,
              mode: t.mode ?? "count-down",
            };
          }
        }
        break;
      }

      case "add-item": {
        const item: RundownItem = {
          id: (payload?.id as string) ?? crypto.randomUUID(),
          title: (payload?.title as string) ?? "Untitled",
          type: (payload?.type as ItemType) ?? "segment",
          duration: (payload?.duration as number) ?? 300000,
          notes: (payload?.notes as string) ?? "",
          assignee: (payload?.assignee as string) ?? "",
          cue: (payload?.cue as string) ?? "",
          status: "upcoming",
          sortOrder: this.state.items.length,
          hardStop: (payload?.hardStop as boolean) ?? false,
          lowerThirdId: payload?.lowerThirdId as string | undefined,
        };
        this.state.items.push(item);
        break;
      }

      case "update-item": {
        const id = payload?.id as string;
        const updates = payload?.updates as Partial<RundownItem>;
        const idx = this.state.items.findIndex((i) => i.id === id);
        if (idx >= 0 && updates) {
          this.state.items[idx] = { ...this.state.items[idx], ...updates };
        }
        break;
      }

      case "remove-item": {
        const id = payload?.id as string;
        this.state.items = this.state.items.filter((i) => i.id !== id);
        break;
      }

      case "reorder": {
        const order = payload?.order as string[];
        if (order) {
          const map = new Map(this.state.items.map((i) => [i.id, i]));
          this.state.items = order
            .map((id) => map.get(id))
            .filter(Boolean) as RundownItem[];
          this.state.items.forEach((item, i) => {
            item.sortOrder = i;
          });
        }
        break;
      }

      case "timer-start": {
        const itemId =
          (payload?.itemId as string) ?? this.state.timer.currentItemId;
        if (itemId) {
          if (
            this.state.timer.currentItemId &&
            this.state.timer.currentItemId !== itemId
          ) {
            const prev = this.state.items.find(
              (i) => i.id === this.state.timer.currentItemId
            );
            if (prev) prev.status = "complete";
          }

          const item = this.state.items.find((i) => i.id === itemId);
          if (item) item.status = "live";

          this.state.timer = {
            playback: "play",
            currentItemId: itemId,
            elapsed: this.state.timer.pausedAt
              ? this.state.timer.elapsed
              : 0,
            startedAt: Date.now(),
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        }
        break;
      }

      case "timer-pause": {
        if (this.state.timer.playback === "play") {
          const now = Date.now();
          const additionalElapsed = this.state.timer.startedAt
            ? now - this.state.timer.startedAt
            : 0;
          this.state.timer.elapsed += additionalElapsed;
          this.state.timer.playback = "pause";
          this.state.timer.pausedAt = now;
          this.state.timer.startedAt = null;
        }
        break;
      }

      case "timer-stop": {
        if (this.state.timer.currentItemId) {
          const item = this.state.items.find(
            (i) => i.id === this.state.timer.currentItemId
          );
          if (item) item.status = "complete";
        }
        this.state.timer = {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: this.state.timer.mode,
        };
        break;
      }

      case "timer-next": {
        const currentIdx = this.state.items.findIndex(
          (i) => i.id === this.state.timer.currentItemId
        );
        if (currentIdx >= 0) {
          this.state.items[currentIdx].status = "complete";
        }
        const nextItem = this.state.items.find(
          (_, i) => i > currentIdx && this.state.items[i].status !== "complete"
        );
        if (nextItem) {
          nextItem.status = "live";
          this.state.timer = {
            playback: "play",
            currentItemId: nextItem.id,
            elapsed: 0,
            startedAt: Date.now(),
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        } else {
          this.state.timer = {
            playback: "stop",
            currentItemId: null,
            elapsed: 0,
            startedAt: null,
            pausedAt: null,
            mode: this.state.timer.mode,
          };
        }
        break;
      }

      case "timer-mode": {
        this.state.timer.mode =
          (payload?.mode as "count-up" | "count-down") ?? "count-down";
        break;
      }

      case "reset": {
        this.state.items.forEach((item) => {
          item.status = "upcoming";
        });
        this.state.timer = {
          playback: "stop",
          currentItemId: null,
          elapsed: 0,
          startedAt: null,
          pausedAt: null,
          mode: this.state.timer.mode,
        };
        break;
      }

      default:
        return;
    }

    this.broadcastState();
  }

  private getPublicState() {
    return {
      items: this.state.items,
      timer: {
        ...this.state.timer,
        serverTime: Date.now(),
      },
    };
  }

  private broadcastState() {
    const data = JSON.stringify({
      type: "state",
      state: this.getPublicState(),
    });
    // Use ctx.getWebSockets() instead of manual Set — survives hibernation
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Dead socket — Cloudflare will clean it up
      }
    }
  }
}
