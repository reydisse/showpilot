import WebSocket from "ws";

/**
 * ProPresenter 7 bridge protocol handler.
 *
 * Connects to PP7's stage display WebSocket on the local network,
 * authenticates, and relays slide data back to ShowPilot.
 */

export interface PPBridgeOptions {
  host: string;
  port: number;
  apiPort?: number;
  password?: string;
  onSlideChange: (data: Record<string, unknown>) => void;
  onStatusChange: (connected: boolean) => void;
}

export interface PPBridgeDebugState {
  connected: boolean;
  wsConnected: boolean;
  pollingActive: boolean;
  useWebSocket: boolean;
  lastPollText: string;
  lastSlideSignature: string;
  lastForwardAt: number;
}

export class ProPresenterBridge {
  private static readonly POLL_INTERVAL_MS = 400;
  private ws: WebSocket | null = null;
  private options: PPBridgeOptions;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private wsConnected = false;
  private pollingActive = false;
  private lastPollText = "";
  private lastSlideSignature = "";
  private lastSlideEvent: Record<string, unknown> | null = null;
  private lastForwardAt = 0;
  private useWebSocket = true;

  constructor(options: PPBridgeOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.destroyed) return;

    // If stage + API ports are the same, treat this as REST-only mode.
    // PP 21.x often exposes slide state on the API port but doesn't keep a
    // stable stage-display websocket there.
    this.useWebSocket = this.options.port !== (this.options.apiPort ?? this.options.port);

    if (this.useWebSocket) {
      const url = `ws://${this.options.host}:${this.options.port}/stagedisplay`;
      console.log(`[pp-bridge] Connecting to ${url}...`);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log("[pp-bridge] Connected to ProPresenter");
        this.wsConnected = true;
        this.emitStatus();

        // Authenticate with stage display protocol
        this.ws?.send(
          JSON.stringify({
            pwd: this.options.password || "",
            ptl: 610,
            acn: "ath",
          })
        );
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch {
          // Ignore unparseable
        }
      });

      this.ws.on("close", () => {
        console.log("[pp-bridge] Disconnected from ProPresenter");
        this.wsConnected = false;
        this.emitStatus();
        if (!this.destroyed) {
          this.reconnectTimer = setTimeout(() => this.connect(), 5000);
        }
      });

      this.ws.on("error", (err) => {
        console.error("[pp-bridge] Error:", err.message);
        // Keep the bridge alive if REST polling is working.
        this.emitStatus();
      });
    } else {
      console.log(
        `[pp-bridge] REST polling only (api port ${this.options.apiPort ?? this.options.port})`
      );
      this.emitStatus();
    }

    this.startPolling();
  }

  disconnect(): void {
    this.destroyed = true;
    this.lastSlideSignature = "";
    this.lastSlideEvent = null;
    this.lastForwardAt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPolling();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.wsConnected = false;
    this.emitStatus();
  }

  replayCurrentSlide(): void {
    if (!this.lastSlideEvent) return;
    this.lastForwardAt = Date.now();
    this.options.onSlideChange({ ...this.lastSlideEvent });
  }

  getDebugState(): PPBridgeDebugState {
    return {
      connected: this.wsConnected || this.pollingActive,
      wsConnected: this.wsConnected,
      pollingActive: this.pollingActive,
      useWebSocket: this.useWebSocket,
      lastPollText: this.lastPollText,
      lastSlideSignature: this.lastSlideSignature,
      lastForwardAt: this.lastForwardAt,
    };
  }

  /** Send a command to PP (for control actions like next slide, clear, etc.) */
  async sendCommand(command: string): Promise<void> {
    const ports = this.getApiPorts();
    const endpoints = this.commandEndpoints(command);

    for (const port of ports) {
      const base = `http://${this.options.host}:${port}`;
      for (const { path, method } of endpoints) {
        try {
          const res = await fetch(`${base}${path}`, {
            method,
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) return;
        } catch {
          // Keep trying fallbacks.
        }
      }
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(command);
      return;
    }

    throw new Error(`No ProPresenter command endpoint worked for ${command}`);
  }

  private handleMessage(data: Record<string, unknown>): void {
    const acn = data.acn as string;

    // Auth response
    if (acn === "ath") {
      const ok = data.ath as boolean;
      console.log(`[pp-bridge] Auth: ${ok ? "success" : "FAILED"}`);
      if (!ok) {
        this.emitStatus();
      }
      return;
    }

    // Timer messages — skip, not slide data
    if (acn === "tmr" || acn === "sys") return;

    const text = this.extractTextFromMessage(data);
    if (!text) return;

    const slideSignature = JSON.stringify(this.normalizeSlidePayload(data));
    if (slideSignature === this.lastSlideSignature) return;

    this.lastSlideSignature = slideSignature;
    this.lastPollText = text;
    this.lastSlideEvent = { ...data };
    this.lastForwardAt = Date.now();
    // Forward everything else — the browser client will parse it
    this.options.onSlideChange({ ...this.lastSlideEvent });
  }

  private startPolling(): void {
    if (this.pollTimer || this.destroyed) return;

    const doPoll = async () => {
      if (this.destroyed) return;
      try {
        const slide = await this.pollSlide();
        if (!slide?.text) return;

        const now = Date.now();
        const shouldForward =
          slide.signature !== this.lastSlideSignature ||
          !this.lastSlideEvent ||
          now - this.lastForwardAt > 10000;

        if (shouldForward) {
          this.lastSlideSignature = slide.signature;
          this.lastPollText = slide.text;
          this.pollingActive = true;
          this.emitStatus();
          this.lastSlideEvent = {
            acn: "sd",
            text: slide.text,
            notes: slide.notes,
            pn: slide.presentationName,
            si: slide.slideIndex,
            scripture: slide.isScripture,
          };
          this.lastForwardAt = now;
          this.options.onSlideChange({ ...this.lastSlideEvent });
        }
      } catch (err) {
        console.error("[pp-bridge] Polling failed:", err instanceof Error ? err.message : String(err));
      }
    };

    this.pollingActive = true;
    this.emitStatus();
    void doPoll();
    this.pollTimer = setInterval(() => {
      void doPoll();
    }, ProPresenterBridge.POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pollingActive = false;
  }

  private emitStatus(): void {
    this.options.onStatusChange(this.wsConnected || this.pollingActive);
  }

  private async pollSlide(): Promise<{ text: string; notes: string; presentationName: string; slideIndex: number; isScripture: boolean; signature: string } | null> {
    const timeout = 2000;
    const endpoints = [
      "/v1/stage/current_slide",
      "/v1/status/slide",
      "/v1/presentation/active",
      "/v1/presentation/slide_index",
      "/v1/stage/layout_map",
    ];

    for (const port of this.getApiPorts()) {
      const base = `http://${this.options.host}:${port}`;
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(`${base}${endpoint}`, { signal: AbortSignal.timeout(timeout) });
          if (!res.ok) continue;
          const payload = (await res.json()) as Record<string, unknown>;
          const text = this.extractTextFromResponse(payload);
          if (text) {
            const signature = JSON.stringify(this.normalizeSlidePayload(payload));
            return {
              text,
              notes: (payload.notes as string) || "",
              presentationName: (payload.presentation_name as string) || (payload.presentation as string) || "",
              slideIndex: typeof payload.current_index === "number" ? payload.current_index : 0,
              isScripture: false,
              signature,
            };
          }
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  private extractTextFromMessage(data: Record<string, unknown>): string {
    const acn = data.acn as string | undefined;
    if (acn === "ath" || acn === "tmr" || acn === "sys") return "";

    if (typeof data.text === "string" && data.text.trim()) return data.text.trim();
    if (typeof data.txt === "string" && data.txt.trim()) return data.txt.trim();

    if (data.cs && typeof data.cs === "object") {
      const cs = data.cs as Record<string, unknown>;
      const slideText = this.extractTextFromSlide(cs);
      if (slideText) return slideText;
    }

    if (Array.isArray(data.ary)) {
      const texts: string[] = [];
      for (const field of data.ary as Array<Record<string, unknown>>) {
        const txt = typeof field.txt === "string" ? field.txt : typeof field.text === "string" ? field.text : "";
        const trimmed = txt.trim();
        if (!trimmed || /^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) continue;
        texts.push(trimmed);
      }
      if (texts.length > 0) return texts.join("\n");
    }

    return "";
  }

  private extractTextFromResponse(data: Record<string, unknown>): string {
    if (typeof data.text === "string" && data.text) return data.text;
    if (typeof data.slide_text === "string" && data.slide_text) return data.slide_text;

    if (data.slide && typeof data.slide === "object") {
      const slide = data.slide as Record<string, unknown>;
      if (typeof slide.text === "string") return slide.text;
    }

    if (data.current && typeof data.current === "object") {
      const current = data.current as Record<string, unknown>;
      if (typeof current.text === "string") return current.text;
    }

    if (Array.isArray(data.slides)) {
      const idx = typeof data.current_index === "number" ? data.current_index : 0;
      const slide = (data.slides as Array<Record<string, unknown>>)[idx];
      if (slide && typeof slide.text === "string") return slide.text;
    }

    if (Array.isArray(data.ary)) {
      const texts: string[] = [];
      for (const item of data.ary as Array<Record<string, unknown>>) {
        if (typeof item.txt === "string" && item.txt.trim()) {
          const trimmed = item.txt.trim();
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) continue;
          texts.push(trimmed);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }

    return "";
  }

  private normalizeSlidePayload(data: Record<string, unknown>): Record<string, unknown> {
    if (data.current && typeof data.current === "object") {
      return data.current as Record<string, unknown>;
    }
    if (data.slide && typeof data.slide === "object") {
      return data.slide as Record<string, unknown>;
    }
    return data;
  }

  private extractTextFromSlide(cs: Record<string, unknown>): string {
    if (typeof cs.csText === "string") return cs.csText;
    if (typeof cs.txt === "string") return cs.txt;
    if (typeof cs.text === "string") return cs.text;

    if (Array.isArray(cs.csTxtAr)) {
      return (cs.csTxtAr as Array<Record<string, string>>)
        .map((t) => t.txt || t.text || "")
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  private commandEndpoints(command: string): Array<{ path: string; method: string }> {
    switch (command) {
      case "next":
        return [
          { path: "/v1/trigger/next", method: "GET" },
          { path: "/v1/trigger/next", method: "POST" },
          { path: "/v1/presentation/active/focus/next", method: "GET" },
        ];
      case "previous":
        return [
          { path: "/v1/trigger/previous", method: "GET" },
          { path: "/v1/trigger/previous", method: "POST" },
          { path: "/v1/presentation/active/focus/previous", method: "GET" },
        ];
      case "clear":
        return [
          { path: "/v1/clear/layer/slide", method: "GET" },
          { path: "/v1/clear/layer/slide", method: "DELETE" },
          { path: "/v1/clear/slide", method: "GET" },
          { path: "/v1/clear/all", method: "GET" },
        ];
      default:
        return [];
    }
  }

  private getApiPorts(): number[] {
    const ports = [this.options.apiPort ?? 1025, this.options.port].filter((port) => Number.isFinite(port) && port > 0) as number[];
    return Array.from(new Set(ports));
  }
}
