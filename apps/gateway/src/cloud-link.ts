/**
 * Cloud Link — outbound WebSocket connection to ShowPilot cloud
 *
 * Connects to the RundownRelay Durable Object via WebSocket.
 * Receives timer/rundown state broadcasts and forwards to local devices.
 * Sends device events (PP slide changes) back to cloud.
 */

import WebSocket from "ws";
import type { BridgeConfig } from "./config.js";

export interface RundownItem {
  id: string;
  title: string;
  type: string;
  duration: number;
  notes: string;
  assignee: string;
  cue: string;
  status: "upcoming" | "live" | "complete";
  sortOrder: number;
  hardStop: boolean;
}

export interface TimerState {
  playback: "stop" | "play" | "pause";
  currentItemId: string | null;
  elapsed: number;
  startedAt: number | null;
  pausedAt: number | null;
  mode: "count-up" | "count-down";
  serverTime?: number;
}

export interface RundownState {
  items: RundownItem[];
  timer: TimerState;
}

export type CloudLinkStatus = "disconnected" | "connecting" | "connected" | "error";

interface CloudLinkEvents {
  onState: (state: RundownState) => void;
  onStatusChange: (status: CloudLinkStatus) => void;
}

export class CloudLink {
  private ws: WebSocket | null = null;
  private config: BridgeConfig;
  private events: CloudLinkEvents;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private status: CloudLinkStatus = "disconnected";
  private destroyed = false;
  private reconnectDelay = 1000;
  private state: RundownState | null = null;

  constructor(config: BridgeConfig, events: CloudLinkEvents) {
    this.config = config;
    this.events = events;
  }

  connect(): void {
    if (this.destroyed) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.setStatus("connecting");

    const cloudBase = this.config.cloudUrl.replace(/^http/, "ws");
    const url = `${cloudBase}/api/rundown/${this.config.orgSlug}/ws`;
    console.log(`[Cloud] Connecting to ${url}`);

    try {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log("[Cloud] Connected");
        this.setStatus("connected");
        this.reconnectDelay = 1000;

        // Keepalive ping every 20s
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 20_000);
      });

      this.ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "hydrate" || msg.type === "state") {
            this.state = msg.state;
            this.events.onState(msg.state);
          }
        } catch {
          // Ignore malformed
        }
      });

      this.ws.on("close", () => {
        console.log("[Cloud] Disconnected");
        this.cleanup();
        this.setStatus("disconnected");
        this.scheduleReconnect();
      });

      this.ws.on("error", (err) => {
        console.warn("[Cloud] WebSocket error:", err.message);
        this.setStatus("error");
      });
    } catch (err) {
      console.error("[Cloud] Failed to connect:", err);
      this.setStatus("error");
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.destroyed = true;
    this.cleanup();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("disconnected");
  }

  sendCommand(action: string, payload?: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "command", action, payload }));
    }
  }

  getState(): RundownState | null {
    return this.state;
  }

  getStatus(): CloudLinkStatus {
    return this.status;
  }

  private setStatus(status: CloudLinkStatus): void {
    this.status = status;
    this.events.onStatusChange(status);
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    console.log(`[Cloud] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
