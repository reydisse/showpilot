/**
 * ProPresenter 7 Browser Client
 *
 * Connects to ProPresenter's API from the operator's browser (same LAN).
 * WebSocket connections from browser to local network IPs bypass CORS.
 *
 * PP7 API runs on a configurable port (default varies, commonly 1025 or custom).
 * Stage Display protocol on port 50001 (legacy).
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
  /** Called when current slide changes */
  onSlideChange: (slide: PPSlideData | null) => void;
  /** Called when connection status changes */
  onStatusChange: (status: PPConnectionStatus, error?: string) => void;
}

/**
 * Browser-side ProPresenter client.
 * Connects via WebSocket to PP7's status updates endpoint.
 */
export class ProPresenterClient {
  private ws: WebSocket | null = null;
  private options: PPClientOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private destroyed = false;
  private currentSlide: PPSlideData | null = null;

  constructor(options: PPClientOptions) {
    this.options = options;
  }

  /** Connect to ProPresenter */
  connect(): void {
    if (this.destroyed) return;
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
        // PP expects a login message with the stage display password
        this.ws?.send(JSON.stringify({
          pwd: "",
          ptl: 610,
          acn: "ath",
        }));
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handleMessage(data);
        } catch {
          // Non-JSON message, ignore
        }
      };

      this.ws.onclose = () => {
        if (!this.destroyed) {
          this.options.onStatusChange("disconnected");
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.options.onStatusChange("error", "Connection failed");
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
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
    this.currentSlide = null;
    this.options.onStatusChange("disconnected");
  }

  /** Get current slide data */
  getCurrentSlide(): PPSlideData | null {
    return this.currentSlide;
  }

  private handleMessage(data: Record<string, unknown>): void {
    const acn = data.acn as string;

    // Stage display current slide update
    if (acn === "fv") {
      // "fv" = frame value — PP sends current slide content
      const cs = data.cs as Record<string, unknown> | undefined; // current slide
      if (cs) {
        const text = this.extractSlideText(cs);
        const notes = (cs.csn as string) || "";
        const presentationName = (data.pn as string) || "";

        // Detect scripture by checking presentation name or notes
        const isScripture = this.detectScripture(presentationName, notes, text);

        this.currentSlide = {
          text,
          notes,
          presentationName,
          slideIndex: (data.si as number) || 0,
          isScripture,
          receivedAt: Date.now(),
        };

        this.options.onSlideChange(this.currentSlide);
      }
    }

    // Authentication response
    if (acn === "ath") {
      const authenticated = data.ath as boolean;
      if (authenticated) {
        this.options.onStatusChange("connected");
      } else {
        this.options.onStatusChange("error", "Authentication failed - check stage display password");
      }
    }
  }

  private extractSlideText(cs: Record<string, unknown>): string {
    // PP stage display protocol sends text in different fields
    // depending on the version. Try common fields.
    if (typeof cs.csText === "string") return cs.csText;
    if (typeof cs.txt === "string") return cs.txt;

    // Array of text elements (PP7 format)
    if (Array.isArray(cs.csTxtAr)) {
      return (cs.csTxtAr as Array<Record<string, string>>)
        .map((t) => t.txt || "")
        .filter(Boolean)
        .join("\n");
    }

    return "";
  }

  private detectScripture(name: string, notes: string, _text: string): boolean {
    // Common Bible book patterns
    const scripturePattern = /\b(genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalm|proverbs|ecclesiastes|song|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelation)\s+\d/i;

    // Check for verse reference pattern (e.g., "3:16", "1:1-5")
    const versePattern = /\d+:\d+/;

    const combined = `${name} ${notes}`;
    return scripturePattern.test(combined) || (versePattern.test(combined) && combined.length < 100);
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

/**
 * Alternative: Fetch current slide via PP7 REST API.
 * Useful for one-shot checks or when WebSocket isn't available.
 * Note: This may be blocked by CORS in some PP versions.
 */
export async function fetchPPCurrentSlide(host: string, port: number): Promise<PPSlideData | null> {
  try {
    const res = await fetch(`http://${host}:${port}/v1/stage/slide`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;

    return {
      text: (data.text as string) || "",
      notes: (data.notes as string) || "",
      presentationName: (data.presentation as string) || "",
      slideIndex: (data.index as number) || 0,
      isScripture: false,
      receivedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
