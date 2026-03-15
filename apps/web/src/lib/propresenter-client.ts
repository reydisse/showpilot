/**
 * ProPresenter 7 Browser Client
 *
 * Dual-mode connection:
 * 1. WebSocket to PP7's stage display protocol (legacy, port 50001)
 * 2. REST polling via server proxy (bypasses CORS, works with PP7 API port)
 *
 * The client tries WebSocket first. If no slide data arrives within a few
 * seconds, it starts REST polling as a fallback. Both can run simultaneously.
 */

export interface PPSlideData {
  /** Current slide text content */
  text: string;
  /** Optional notes/scripture reference */
  notes: string;
  /** Presentation name (e.g., "Worship Set" or "John 3:16") */
  presentationName: string;
  /** Slide index within the presentation */
  slideIndex: number;
  /** Whether this is a scripture/Bible presentation */
  isScripture: boolean;
  /** Timestamp when slide was received */
  receivedAt: number;
}

export type PPConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface PPClientOptions {
  host: string;
  port: number;
  /** Stage display password (set in PP preferences → Network) */
  password?: string;
  /** Called when current slide changes */
  onSlideChange: (slide: PPSlideData | null) => void;
  /** Called when connection status changes */
  onStatusChange: (status: PPConnectionStatus, error?: string) => void;
  /** Called with debug info for troubleshooting */
  onDebug?: (info: PPDebugInfo) => void;
}

export interface PPDebugInfo {
  wsConnected: boolean;
  wsMessagesReceived: number;
  lastWsMessage: string | null;
  lastSlideText: string | null;
  pollingActive: boolean;
  pollSuccessCount: number;
  lastPollResult: string | null;
}

/**
 * Browser-side ProPresenter client.
 * Uses WebSocket (stage display protocol) + REST polling fallback.
 */
export class ProPresenterClient {
  private ws: WebSocket | null = null;
  private options: PPClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private destroyed = false;
  private currentSlide: PPSlideData | null = null;

  // Polling state
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollFn: ((host: string, port: number) => Promise<PPSlideData | null>) | null = null;
  private lastPollText = "";

  // Debug tracking
  private wsMessagesReceived = 0;
  private lastWsMessage: string | null = null;
  private wsSlideReceived = false;
  private pollSuccessCount = 0;
  private lastPollResult: string | null = null;

  constructor(options: PPClientOptions) {
    this.options = options;
  }

  /**
   * Connect to ProPresenter.
   * @param pollFn Optional server-side polling function (bypasses CORS)
   */
  connect(pollFn?: (host: string, port: number) => Promise<PPSlideData | null>): void {
    if (this.destroyed) return;
    this.pollFn = pollFn || null;
    this.clearReconnectTimer();
    this.options.onStatusChange("connecting");

    try {
      // PP7 WebSocket endpoint for stage display updates
      const wsUrl = `ws://${this.options.host}:${this.options.port}/stagedisplay`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.options.onStatusChange("connected");

        // Send authentication (PP stage display protocol)
        this.ws?.send(JSON.stringify({
          pwd: this.options.password || "",
          ptl: 610,
          acn: "ath",
        }));

        // Always start REST polling alongside WS.
        // WS often only sends timer messages, not slide content.
        // If WS delivers a real slide, polling will be stopped.
        if (this.pollFn) {
          console.log("[PP] Starting REST polling alongside WS");
          this.startPolling();
        }
      };

      this.ws.onmessage = (event) => {
        this.wsMessagesReceived++;
        try {
          const data = JSON.parse(event.data as string);
          const summary = JSON.stringify(data).slice(0, 300);
          this.lastWsMessage = summary;
          console.log("[PP WS]", summary);
          this.emitDebug();
          this.handleMessage(data);
        } catch {
          const raw = String(event.data).slice(0, 200);
          this.lastWsMessage = raw;
          console.log("[PP WS raw]", raw);
          this.emitDebug();
        }
      };

      this.ws.onclose = () => {
        if (!this.destroyed) {
          this.options.onStatusChange("disconnected");
          this.stopPolling();
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // WS failed — try polling-only mode if we have a poll function
        if (this.pollFn && !this.destroyed) {
          console.log("[PP] WebSocket failed, trying REST polling only");
          this.options.onStatusChange("connected");
          this.startPolling();
        } else {
          this.options.onStatusChange("error", "Connection failed");
        }
        this.ws?.close();
      };
    } catch (err) {
      this.options.onStatusChange("error", `Failed to connect: ${err}`);
      this.scheduleReconnect();
    }
  }

  /** Disconnect and stop reconnecting */
  disconnect(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.stopPolling();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.currentSlide = null;
    this.wsSlideReceived = false;
    this.wsMessagesReceived = 0;
    this.lastWsMessage = null;
    this.pollSuccessCount = 0;
    this.lastPollResult = null;
    this.options.onStatusChange("disconnected");
  }

  /** Get current slide data */
  getCurrentSlide(): PPSlideData | null {
    return this.currentSlide;
  }

  /** Get current debug info */
  getDebugInfo(): PPDebugInfo {
    return {
      wsConnected: this.ws?.readyState === WebSocket.OPEN,
      wsMessagesReceived: this.wsMessagesReceived,
      lastWsMessage: this.lastWsMessage,
      lastSlideText: this.currentSlide?.text || null,
      pollingActive: this.pollTimer !== null,
      pollSuccessCount: this.pollSuccessCount,
      lastPollResult: this.lastPollResult,
    };
  }

  private emitDebug(): void {
    this.options.onDebug?.(this.getDebugInfo());
  }

  private startPolling(): void {
    if (this.pollTimer || !this.pollFn) return;
    console.log("[PP] Starting REST poll every 1.5s");

    const doPoll = async () => {
      if (this.destroyed || !this.pollFn) return;
      try {
        const slide = await this.pollFn(this.options.host, this.options.port);
        if (slide && slide.text) {
          this.pollSuccessCount++;
          this.lastPollResult = `OK: "${slide.text.slice(0, 60)}"`;

          // Only emit change if text actually changed
          if (slide.text !== this.lastPollText) {
            this.lastPollText = slide.text;
            this.currentSlide = slide;
            this.options.onSlideChange(slide);
          }
        } else {
          this.lastPollResult = "No slide data";
        }
      } catch (err) {
        this.lastPollResult = `Error: ${err}`;
      }
      this.emitDebug();
    };

    // Immediate first poll
    doPoll();
    this.pollTimer = setInterval(doPoll, 1500);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private handleMessage(data: Record<string, unknown>): void {
    const acn = data.acn as string;

    // Authentication response
    if (acn === "ath") {
      const authenticated = data.ath as boolean;
      if (authenticated) {
        this.options.onStatusChange("connected");
      } else {
        this.options.onStatusChange("error", "Authentication failed - check stage display password");
      }
      return;
    }

    // Stage display current slide update — "fv" = frame value
    if (acn === "fv") {
      const cs = data.cs as Record<string, unknown> | undefined;
      if (cs) {
        const text = this.extractSlideText(cs);
        const notes = (cs.csn as string) || "";
        const presentationName = (data.pn as string) || "";
        const isScripture = this.detectScripture(presentationName, notes, text);

        if (text) {
          this.wsSlideReceived = true;
          this.stopPolling(); // WS is working, no need to poll
          this.currentSlide = {
            text,
            notes,
            presentationName,
            slideIndex: (data.si as number) || 0,
            isScripture,
            receivedAt: Date.now(),
          };
          this.options.onSlideChange(this.currentSlide);
          this.emitDebug();
        }
      }
      return;
    }

    // PP7 may send "sd" (stage display) messages with different structure
    if (acn === "sd") {
      const text = this.extractTextFromAny(data);
      if (text) {
        this.wsSlideReceived = true;
        this.stopPolling();
        this.currentSlide = {
          text,
          notes: "",
          presentationName: (data.pn as string) || "",
          slideIndex: 0,
          isScripture: false,
          receivedAt: Date.now(),
        };
        this.options.onSlideChange(this.currentSlide);
        this.emitDebug();
      }
      return;
    }

    // Fallback: try to extract text from any message that has slide-like content
    if (!acn || (acn !== "ath" && acn !== "tmr" && acn !== "sys")) {
      const text = this.extractTextFromAny(data);
      if (text && text.length > 1) {
        this.wsSlideReceived = true;
        this.stopPolling();
        this.currentSlide = {
          text,
          notes: "",
          presentationName: (data.pn as string) || (data.presentationName as string) || "",
          slideIndex: (data.si as number) || (data.slideIndex as number) || 0,
          isScripture: false,
          receivedAt: Date.now(),
        };
        this.options.onSlideChange(this.currentSlide);
        this.emitDebug();
      }
    }
  }

  /** Try to extract text from any PP message structure */
  private extractTextFromAny(data: Record<string, unknown>): string {
    // Direct text field
    if (typeof data.text === "string" && data.text) return data.text;
    if (typeof data.txt === "string" && data.txt) return data.txt;

    // cs (current slide) sub-object
    if (data.cs && typeof data.cs === "object") {
      const cs = data.cs as Record<string, unknown>;
      const t = this.extractSlideText(cs);
      if (t) return t;
    }

    // ary (array of fields) — PP7 stage display format
    // Filter out timer/clock fields to only get slide content
    if (Array.isArray(data.ary)) {
      const texts: string[] = [];
      for (const field of data.ary as Array<Record<string, unknown>>) {
        // Skip timer fields
        const acn = field.acn as string | undefined;
        if (acn === "tmr") continue;
        const txt = (typeof field.txt === "string" && field.txt) ? field.txt
          : (typeof field.text === "string" && field.text) ? field.text
          : null;
        if (txt) {
          // Skip timer-formatted strings (e.g. "00:05:30", "5:30")
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(txt.trim())) continue;
          texts.push(txt);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }

    // Deep scan: look for any string field that looks like slide text
    for (const [key, val] of Object.entries(data)) {
      if (key === "acn" || key === "pwd" || key === "ptl") continue;
      if (typeof val === "string" && val.length > 3 && val.length < 2000) {
        // Skip fields that look like IDs, timestamps, or status codes
        if (/^[0-9a-f-]+$/i.test(val) || /^\d+$/.test(val)) continue;
        // Skip timer-formatted strings
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(val.trim())) continue;
        return val;
      }
      // One-level deep object scan
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        for (const [, subVal] of Object.entries(obj)) {
          if (typeof subVal === "string" && subVal.length > 3 && subVal.length < 2000) {
            if (/^[0-9a-f-]+$/i.test(subVal) || /^\d+$/.test(subVal)) continue;
            return subVal;
          }
        }
      }
    }

    return "";
  }

  private extractSlideText(cs: Record<string, unknown>): string {
    // PP stage display protocol sends text in different fields
    if (typeof cs.csText === "string") return cs.csText;
    if (typeof cs.txt === "string") return cs.txt;
    if (typeof cs.text === "string") return cs.text;

    // Array of text elements (PP7 format)
    if (Array.isArray(cs.csTxtAr)) {
      return (cs.csTxtAr as Array<Record<string, string>>)
        .map((t) => t.txt || t.text || "")
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  private detectScripture(name: string, notes: string, _text: string): boolean {
    const scripturePattern = /\b(genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|proverbs|ecclesiastes|song|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\s+\d/i;
    const versePattern = /\d+:\d+/;
    const combined = `${name} ${notes}`;
    return scripturePattern.test(combined) || (versePattern.test(combined) && combined.length < 100);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(this.pollFn || undefined), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
