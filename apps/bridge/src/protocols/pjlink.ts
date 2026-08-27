import { createHash } from "node:crypto";
import net from "node:net";

const RESPONSE_TIMEOUT_MS = 5_000;
const PJLINK_COMMAND = /^%[12][A-Z0-9]{4}(?: [^\r\n]*)?\r$/;

/** Managed PJLink Class 1/2 connection with the protocol greeting and MD5 authentication. */
export class PjlinkConnection {
  private socket: net.Socket | null = null;
  private connected = false;
  private authenticationPrefix = "";
  private commandTail: Promise<void> = Promise.resolve();

  async connect(host: string, port: number, password?: string): Promise<void> {
    if (password !== undefined && !/^[A-Za-z0-9]{1,32}$/.test(password)) {
      throw new Error("PJLink password must be 1-32 ASCII letters or numbers");
    }

    const socket = new net.Socket();
    socket.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      let greeting = "";
      let settled = false;
      const timer = setTimeout(() => fail(new Error(`PJLink greeting timeout from ${host}:${port}`)), RESPONSE_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        socket.removeListener("error", fail);
        socket.removeListener("close", onClose);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onClose = () => fail(new Error("PJLink device disconnected during greeting"));
      const onData = (data: Buffer) => {
        greeting += data.toString("ascii");
        if (greeting.length > 80) {
          fail(new Error("Invalid PJLink greeting"));
          return;
        }
        const end = greeting.indexOf("\r");
        if (end === -1) return;

        const line = greeting.slice(0, end);
        if (line === "PJLINK 0") {
          this.authenticationPrefix = "";
        } else {
          const authenticated = /^PJLINK 1 ([0-9a-f]{8})$/.exec(line);
          if (!authenticated) {
            fail(new Error("Invalid PJLink greeting"));
            return;
          }
          if (!password) {
            fail(new Error("PJLink device requires a password"));
            return;
          }
          this.authenticationPrefix = createHash("md5")
            .update(`${authenticated[1]}${password}`, "ascii")
            .digest("hex");
        }

        settled = true;
        cleanup();
        this.socket = socket;
        this.connected = true;
        socket.on("error", () => {
          this.connected = false;
        });
        socket.on("close", () => {
          this.connected = false;
        });
        resolve();
      };

      socket.on("data", onData);
      socket.on("error", fail);
      socket.on("close", onClose);
      socket.connect(port, host);
    });
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
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
    const socket = this.socket;
    if (!socket || !this.connected) throw new Error("PJLink is not connected");
    if (!PJLINK_COMMAND.test(command)) throw new Error("Invalid PJLink command");

    return await new Promise<string>((resolve, reject) => {
      let response = "";
      let settled = false;
      const timer = setTimeout(() => fail(new Error("PJLink response timeout")), RESPONSE_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        socket.removeListener("error", fail);
        socket.removeListener("close", onClose);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onClose = () => fail(new Error("PJLink device disconnected"));
      const onData = (data: Buffer) => {
        response += data.toString("ascii");
        if (response.length > 512) {
          fail(new Error("Invalid PJLink response"));
          return;
        }
        const end = response.indexOf("\r");
        if (end === -1) return;
        const line = response.slice(0, end);
        if (line === "PJLINK ERRA") {
          fail(new Error("PJLink authentication failed"));
          return;
        }
        if (/^%[12][A-Z0-9]{4}=ERR[1-4A]$/.test(line)) {
          fail(new Error(`PJLink device rejected the command: ${line.slice(-4)}`));
          return;
        }
        settled = true;
        cleanup();
        resolve(`${line}\r`);
      };

      socket.on("data", onData);
      socket.on("error", fail);
      socket.on("close", onClose);
      socket.write(`${this.authenticationPrefix}${command}`, "ascii");
    });
  }
}
