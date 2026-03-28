import type { TransportType, ConnectivityMode, AdapterField } from "../../types";
import type { ProtocolDriver } from "../protocol-driver";

/**
 * Generic HTTP Command protocol driver.
 * Browser-direct — uses fetch() to send GET/POST to any REST API device.
 *
 * Command format: "METHOD /path [body]"
 * Examples:
 *   "GET /api/power/status"
 *   "POST /api/command {\"action\":\"power_on\"}"
 *   "/status"  (defaults to GET)
 */
export class HttpCommandDriver implements ProtocolDriver {
  readonly protocolId = "http-command";
  readonly transport: TransportType = "http";
  readonly connectivity: ConnectivityMode = "browser-direct";
  readonly baseConfigFields: AdapterField[] = [
    { key: "host", label: "Host / IP", placeholder: "192.168.1.50", required: true },
    { key: "port", label: "Port", placeholder: "80", type: "number" },
    { key: "basePath", label: "Base Path", placeholder: "/api" },
    { key: "authToken", label: "Auth Token", type: "password" },
  ];

  private baseUrl = "";
  private authToken: string | undefined;
  private connected = false;

  async connect(settings: Record<string, unknown>): Promise<void> {
    const host = settings.host as string;
    const port = settings.port ?? 80;
    const basePath = (settings.basePath as string) || "";
    this.authToken = settings.authToken as string | undefined;

    this.baseUrl = `http://${host}:${port}${basePath}`;

    // Ping to verify connectivity
    const res = await fetch(
      basePath ? this.baseUrl : `${this.baseUrl}/`,
      { method: "GET", headers: this.buildHeaders() }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  async sendCommand(command: string): Promise<string | void> {
    const { method, path, body } = this.parseCommand(command);
    const url = `${this.baseUrl}${path}`;

    const options: RequestInit = {
      method,
      headers: this.buildHeaders(),
    };
    if (body) {
      options.body = body;
      (options.headers as Record<string, string>)["Content-Type"] = "application/json";
    }

    const res = await fetch(url, options);
    return await res.text();
  }

  onEvent(_callback: (eventName: string, data: string) => void): () => void {
    // HTTP is request/response — no unsolicited events
    return () => {};
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ─── Helpers ────────────────────────────────────────────

  private parseCommand(command: string): { method: string; path: string; body?: string } {
    const trimmed = command.trim();

    // Check for METHOD prefix
    const methodMatch = trimmed.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i);
    if (methodMatch) {
      const method = methodMatch[1].toUpperCase();
      const rest = trimmed.slice(methodMatch[0].length);
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx > 0) {
        return { method, path: rest.slice(0, spaceIdx), body: rest.slice(spaceIdx + 1) };
      }
      return { method, path: rest };
    }

    // Default to GET
    return { method: "GET", path: trimmed };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers["Authorization"] = `Bearer ${this.authToken}`;
    }
    return headers;
  }
}
