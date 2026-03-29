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
  password?: string;
  onSlideChange: (data: Record<string, unknown>) => void;
  onStatusChange: (connected: boolean) => void;
}

export class ProPresenterBridge {
  private ws: WebSocket | null = null;
  private options: PPBridgeOptions;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(options: PPBridgeOptions) {
    this.options = options;
  }

  connect(): void {
    if (this.destroyed) return;

    const url = `ws://${this.options.host}:${this.options.port}/stagedisplay`;
    console.log(`[pp-bridge] Connecting to ${url}...`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      console.log("[pp-bridge] Connected to ProPresenter");
      this.options.onStatusChange(true);

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
      this.options.onStatusChange(false);
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on("error", (err) => {
      console.error("[pp-bridge] Error:", err.message);
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.options.onStatusChange(false);
  }

  /** Send a command to PP (for control actions like next slide, clear, etc.) */
  sendCommand(command: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(command);
    }
  }

  private handleMessage(data: Record<string, unknown>): void {
    const acn = data.acn as string;

    // Auth response
    if (acn === "ath") {
      const ok = data.ath as boolean;
      console.log(`[pp-bridge] Auth: ${ok ? "success" : "FAILED"}`);
      if (!ok) {
        this.options.onStatusChange(false);
      }
      return;
    }

    // Timer messages — skip, not slide data
    if (acn === "tmr" || acn === "sys") return;

    // Forward everything else — the browser client will parse it
    this.options.onSlideChange(data);
  }
}
