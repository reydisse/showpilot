import net from "net";

/**
 * Managed TCP connection — used for PJLink, Extron SIS, QSC, and other
 * line-based TCP protocols.
 */
export class TcpConnection {
  private socket: net.Socket | null = null;
  private connected = false;
  private responseTimeout = 5000;

  async connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, this.responseTimeout);

      socket.connect(port, host, () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connected = true;
        resolve();
      });

      socket.on("error", (err) => {
        clearTimeout(timer);
        this.connected = false;
        reject(err);
      });

      socket.on("close", () => {
        this.connected = false;
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendCommand(command: string): Promise<string> {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Response timeout"));
      }, this.responseTimeout);

      const onData = (data: Buffer) => {
        clearTimeout(timer);
        this.socket?.removeListener("data", onData);
        resolve(data.toString());
      };

      this.socket!.on("data", onData);
      this.socket!.write(command);
    });
  }
}
