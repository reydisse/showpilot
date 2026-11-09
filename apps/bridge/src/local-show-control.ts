import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  parseRundownTransport,
  type RundownTransportCommand,
} from "@showpilot/shared/rundown-transport";
import { LocalShowError } from "./local-show-model.js";

export type LocalShowRequest =
  | { operation: "status" }
  | { operation: "begin"; sessionId: string; confirmed: true }
  | { operation: "discard"; sessionId: string; confirmed: true }
  | { operation: "finish"; sessionId: string; expectedSequence: number }
  | { operation: "reconciled"; sessionId: string; expectedSequence: number }
  | {
      operation: "transport";
      sessionId: string;
      requestId: string;
      expectedSequence: number;
      command: RundownTransportCommand;
    }
  | {
      operation: "device";
      sessionId: string;
      requestId: string;
      expectedSequence: number;
      actionId: string;
    };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,100}$/.test(value);

export function parseLocalShowRequest(value: unknown): LocalShowRequest | null {
  if (!record(value)) return null;
  if (value.operation === "status") return { operation: "status" };
  if (!identifier(value.sessionId)) return null;
  const sessionId = value.sessionId;
  if (value.operation === "begin" || value.operation === "discard")
    return value.confirmed === true
      ? { operation: value.operation, sessionId, confirmed: true }
      : null;
  if (
    typeof value.expectedSequence !== "number" ||
    !Number.isSafeInteger(value.expectedSequence) ||
    value.expectedSequence < 0
  )
    return null;
  const expectedSequence = value.expectedSequence;
  if (value.operation === "finish" || value.operation === "reconciled")
    return { operation: value.operation, sessionId, expectedSequence };
  if (!identifier(value.requestId)) return null;
  const requestId = value.requestId;
  if (value.operation === "device")
    return identifier(value.actionId)
      ? {
          operation: "device",
          sessionId,
          requestId,
          expectedSequence,
          actionId: value.actionId,
        }
      : null;
  if (value.operation === "transport") {
    const command = parseRundownTransport(value.action, value.payload);
    return command
      ? {
          operation: "transport",
          sessionId,
          requestId,
          expectedSequence,
          command,
        }
      : null;
  }
  return null;
}

/** Only the native parent receives this ephemeral token. Browser origins,
 * arbitrary device payloads, oversized requests, and unbounded work are rejected.
 */
export async function startLocalShowControl(
  token: string,
  handle: (request: LocalShowRequest) => Promise<unknown>,
) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new Error("Local control requires a random parent-issued token.");
  const authorization = Buffer.from(`Bearer ${token}`);
  const active = { device: 0, control: 0 };
  const server = http.createServer(
    { requestTimeout: 2000, headersTimeout: 2000, maxHeaderSize: 4096 },
    async (request, response) => {
      const reply = (status: number, value: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(value));
      };
      const presented = Buffer.from(request.headers.authorization ?? "");
      if (
        request.headers.origin !== undefined ||
        presented.length !== authorization.length ||
        !timingSafeEqual(presented, authorization)
      ) {
        reply(401, {
          ok: false,
          error: "Native local control authorization required.",
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/local-show") {
        reply(404, { ok: false });
        return;
      }
      let slot: "device" | "control" | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        let length = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 65536) {
            reply(413, {
              ok: false,
              error: "Local control request is too large.",
            });
            return;
          }
          chunks.push(chunk);
        }
        let input: unknown;
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          reply(400, { ok: false, error: "Invalid local control request." });
          return;
        }
        const command = parseLocalShowRequest(input);
        if (!command) {
          reply(400, { ok: false, error: "Invalid local control request." });
          return;
        }
        const category = command.operation === "device" ? "device" : "control";
        if (active[category] >= 8) {
          reply(503, {
            ok: false,
            error:
              "Local show engine is busy. Refresh its status before retrying.",
          });
          return;
        }
        // Slow equipment cannot consume the slots needed by status and timers.
        slot = category;
        active[slot]++;
        timeout = setTimeout(
          () =>
            reply(504, {
              ok: false,
              error:
                "The local action has not confirmed. Refresh its result before retrying.",
            }),
          15000,
        );
        // Keep the active slot until the actual work finishes, even if HTTP times
        // out. Retrying a stalled action cannot create unbounded background work.
        const result = await handle(command);
        reply(200, { ok: true, result });
      } catch (error) {
        // Adapter exceptions can contain private settings. The manager returns
        // explicit safe operator errors/results; unexpected exceptions stay private.
        if (error instanceof LocalShowError)
          reply(409, { ok: false, error: error.message });
        else
          reply(500, {
            ok: false,
            error:
              "Local show action failed. Refresh the saved state before retrying.",
          });
      } finally {
        clearTimeout(timeout);
        if (slot) active[slot]--;
      }
    },
  );
  server.maxConnections = 24;
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local show control did not bind a loopback port.");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
