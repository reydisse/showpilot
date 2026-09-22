import net from "net";

/**
 * Managed TCP connection — used for PJLink, Extron SIS, QSC, and other
 * line-based TCP protocols.
 */
export class TcpConnection {
  private socket: net.Socket | null = null;
  private connected = false;
  private responseTimeout = 5000;
  private commandTail: Promise<void> = Promise.resolve();

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
    const result = this.commandTail.then(() => this.sendCommandNow(command));
    this.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async sendCommandNow(command: string): Promise<string> {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }

    return new Promise((resolve, reject) => {
      const socket = this.socket!;
      const lineFramed = /[\r\n]$/.test(command);
      let response = "";
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      };
      const fail = (error: Error, invalidate = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (invalidate) this.disconnect();
        reject(error);
      };
      const timer = setTimeout(() => {
        // Once a request has timed out, an eventual reply cannot be safely
        // correlated with the next command. Drop the ambiguous connection.
        fail(new Error("Response timeout"), true);
      }, this.responseTimeout);

      const onData = (data: Buffer) => {
        response += data.toString();
        if (lineFramed && !/[\r\n]/.test(response)) return;
        settled = true;
        cleanup();
        resolve(response);
      };
      const onError = (error: Error) => fail(error);
      const onClose = () => fail(new Error("Connection closed before the device replied"));

      socket.on("data", onData);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.write(command);
    });
  }
}
