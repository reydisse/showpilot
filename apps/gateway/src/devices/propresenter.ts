/**
 * ProPresenter Device Driver
 *
 * Connects to ProPresenter 7 on the local network via:
 * 1. WebSocket (stage display protocol, port 50001)
 * 2. REST API (port 1025 by default)
 *
 * Receives slide changes and can send commands (next/prev/trigger).
 */

import WebSocket from "ws";
import type { DeviceConfig } from "../config.js";

export interface PPSlideData {
  text: string;
  notes: string;
  presentationName: string;
  slideIndex: number;
  isScripture: boolean;
  receivedAt: number;
}

export type PPStatus = "disconnected" | "connecting" | "connected" | "error";

interface PPEvents {
  onSlideChange: (slide: PPSlideData | null) => void;
  onStatusChange: (status: PPStatus) => void;
}

export class ProPresenterDevice {
  private config: DeviceConfig;
  private events: PPEvents;
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private reconnectAttempts = 0;
  private currentSlide: PPSlideData | null = null;
  private lastPollText = "";
  private status: PPStatus = "disconnected";

  constructor(config: DeviceConfig, events: PPEvents) {
    this.config = config;
    this.events = events;
  }

  connect(): void {
    if (this.destroyed) return;
    this.setStatus("connecting");

    // PP7 supports both /stagedisplay (legacy PP6 compat) and /remote (native PP7).
    // Try /stagedisplay first as it's the standard stage display protocol.
    const wsUrl = `ws://${this.config.host}:${this.config.port}/stagedisplay`;
    console.log(`[PP:${this.config.name}] Connecting to ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        console.log(`[PP:${this.config.name}] WebSocket connected`);
        this.reconnectAttempts = 0;
        this.setStatus("connected");

        // Authenticate with stage display
        this.ws?.send(JSON.stringify({
          pwd: this.config.password || "",
          ptl: 610,
          acn: "ath",
        }));

        // Keepalive ping every 15s — PP7's stage display shim drops idle connections
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 15_000);

        // Start REST polling alongside WS (WS often only sends timers, not slides)
        this.startPolling();
      });

      this.ws.on("message", (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this.handleWSMessage(data);
        } catch {
          // Ignore
        }
      });

      this.ws.on("close", () => {
        this.cleanupConnection();
        if (!this.destroyed) {
          this.setStatus("disconnected");
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        console.warn(`[PP:${this.config.name}] WS error:`, err.message);
        this.cleanupConnection();
        // Fall back to REST polling only
        if (!this.destroyed && this.config.apiPort) {
          console.log(`[PP:${this.config.name}] Falling back to REST polling on port ${this.config.apiPort}`);
          this.setStatus("connected");
          this.startPolling();
        } else {
          this.setStatus("error");
          this.scheduleReconnect();
        }
      });
    } catch (err) {
      console.error(`[PP:${this.config.name}] Failed:`, err);
      this.setStatus("error");
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.destroyed = true;
    this.cleanupConnection();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("disconnected");
  }

  private cleanupConnection(): void {
    this.stopPolling();
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

  /** Send a command to ProPresenter via REST API */
  async sendCommand(command: "next" | "prev" | "trigger", payload?: { index?: number; presentationPath?: string }): Promise<boolean> {
    if (!this.config.allowControl) {
      console.warn(`[PP:${this.config.name}] Control disabled — ignoring ${command}`);
      return false;
    }

    const apiPort = this.config.apiPort || 1025;
    const base = `http://${this.config.host}:${apiPort}`;

    try {
      let res: Response;
      switch (command) {
        case "next":
          res = await fetch(`${base}/v1/trigger/next`, { method: "GET" });
          break;
        case "prev":
          res = await fetch(`${base}/v1/trigger/previous`, { method: "GET" });
          break;
        case "trigger":
          if (payload?.index !== undefined) {
            res = await fetch(`${base}/v1/trigger/slide_index/${payload.index}`, { method: "GET" });
          } else {
            return false;
          }
          break;
        default:
          return false;
      }
      return res.ok;
    } catch (err) {
      console.warn(`[PP:${this.config.name}] Command ${command} failed:`, err);
      return false;
    }
  }

  getStatus(): PPStatus {
    return this.status;
  }

  getCurrentSlide(): PPSlideData | null {
    return this.currentSlide;
  }

  private setStatus(status: PPStatus): void {
    this.status = status;
    this.events.onStatusChange(status);
  }

  private handleWSMessage(data: Record<string, unknown>): void {
    const acn = data.acn as string;

    if (acn === "ath") {
      if (!(data.ath as boolean)) {
        console.warn(`[PP:${this.config.name}] Auth failed`);
        this.setStatus("error");
      }
      return;
    }

    // Stage display slide update
    if (acn === "fv" || acn === "sd") {
      const text = this.extractText(data);
      if (text) {
        this.stopPolling(); // WS is delivering slide content
        this.emitSlide(text, data);
      }
    }
  }

  private startPolling(): void {
    if (this.pollTimer || !this.config.apiPort) return;
    const apiPort = this.config.apiPort;
    const base = `http://${this.config.host}:${apiPort}`;

    const doPoll = async () => {
      if (this.destroyed) return;
      try {
        // Try PP7 v1 API first
        const res = await fetch(`${base}/v1/stage/current_slide`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const text = typeof data.text === "string" ? data.text : "";
          if (text && text !== this.lastPollText) {
            this.lastPollText = text;
            this.emitSlide(text, data);
          }
          return;
        }
      } catch {
        // Try alternate endpoint
      }

      try {
        const res = await fetch(`${base}/v1/status/slide`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, unknown>;
          const text = (data.current_slide_text as string) || "";
          if (text && text !== this.lastPollText) {
            this.lastPollText = text;
            this.emitSlide(text, data);
          }
        }
      } catch {
        // Both failed — PP might not be running
      }
    };

    doPoll();
    this.pollTimer = setInterval(doPoll, 1500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private emitSlide(text: string, data: Record<string, unknown>): void {
    // Filter out timer/clock strings
    const trimmed = text.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) return;
    if (/^[\d:.\-\s]+$/.test(trimmed)) return;
    if (trimmed.length < 3) return;

    const slide: PPSlideData = {
      text,
      notes: (data.notes as string) || (data.csn as string) || "",
      presentationName: (data.pn as string) || (data.presentationName as string) || "",
      slideIndex: (data.si as number) || 0,
      isScripture: this.detectScripture(
        (data.pn as string) || "",
        (data.notes as string) || "",
      ),
      receivedAt: Date.now(),
    };

    this.currentSlide = slide;
    this.events.onSlideChange(slide);
  }

  private extractText(data: Record<string, unknown>): string {
    // cs.csText or cs.txt
    const cs = data.cs as Record<string, unknown> | undefined;
    if (cs) {
      if (typeof cs.csText === "string") return cs.csText;
      if (typeof cs.txt === "string") return cs.txt;
      if (typeof cs.text === "string") return cs.text;
      if (Array.isArray(cs.csTxtAr)) {
        return (cs.csTxtAr as Array<Record<string, string>>)
          .map((t) => t.txt || t.text || "")
          .filter(Boolean)
          .join("\n");
      }
    }

    // Direct text field
    if (typeof data.text === "string" && data.text) return data.text;
    if (typeof data.txt === "string" && data.txt) return data.txt;

    // Array of fields
    if (Array.isArray(data.ary)) {
      const texts: string[] = [];
      for (const field of data.ary as Array<Record<string, unknown>>) {
        if ((field.acn as string) === "tmr") continue;
        const txt = (field.txt as string) || (field.text as string) || "";
        if (txt && !/^\d{1,2}:\d{2}(:\d{2})?$/.test(txt.trim())) {
          texts.push(txt);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }

    return "";
  }

  private detectScripture(name: string, notes: string): boolean {
    const pattern = /\b(genesis|exodus|psalm|proverbs|isaiah|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|hebrews|james|peter|revelation)\s+\d/i;
    const combined = `${name} ${notes}`;
    return pattern.test(combined) || (/\d+:\d+/.test(combined) && combined.length < 100);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer) return;
    // Cap backoff at 10s — PP is on local network, no reason to wait 30s
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10_000);
    this.reconnectAttempts++;
    console.log(`[PP:${this.config.name}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
