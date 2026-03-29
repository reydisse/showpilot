import dgram from "dgram";

/**
 * Managed UDP connection — used for OSC, VISCA-over-IP, Wake-on-LAN, sACN.
 */
export class UdpConnection {
  private socket: dgram.Socket | null = null;
  private host = "";
  private port = 0;
  private responseTimeout = 3000;

  async connect(host: string, port: number): Promise<void> {
    this.host = host;
    this.port = port;

    return new Promise((resolve, reject) => {
      try {
        this.socket = dgram.createSocket("udp4");
        this.socket.on("error", (err) => {
          reject(err);
        });
        // UDP is connectionless — just bind and we're ready
        this.socket.bind(0, () => resolve());
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  /** Send data and optionally wait for a response */
  async send(data: Buffer): Promise<Buffer | void> {
    if (!this.socket) throw new Error("Not connected");

    return new Promise((resolve, reject) => {
      this.socket!.send(data, this.port, this.host, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Send and wait for response (for request/response protocols) */
  async sendAndReceive(data: Buffer): Promise<Buffer> {
    if (!this.socket) throw new Error("Not connected");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket?.removeListener("message", onMessage);
        reject(new Error("Response timeout"));
      }, this.responseTimeout);

      const onMessage = (msg: Buffer) => {
        clearTimeout(timer);
        this.socket?.removeListener("message", onMessage);
        resolve(msg);
      };

      this.socket!.on("message", onMessage);
      this.socket!.send(data, this.port, this.host, (err) => {
        if (err) {
          clearTimeout(timer);
          this.socket?.removeListener("message", onMessage);
          reject(err);
        }
      });
    });
  }

  /** Listen for incoming messages (for event-driven protocols) */
  onMessage(callback: (data: Buffer, rinfo: dgram.RemoteInfo) => void): () => void {
    if (!this.socket) return () => {};
    this.socket.on("message", callback);
    return () => this.socket?.removeListener("message", callback);
  }
}
