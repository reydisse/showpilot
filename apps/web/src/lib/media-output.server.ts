import { z } from "zod";
import { socketReadLeaseAllows } from "./socket-read-authority.server";
import { mediaAssetSchema } from "./media-library";
import { mediaStorageKey } from "./media-library.server";
import {
  MEDIA_OUTPUT_LEASE_MS,
  mediaOutputKey,
  mediaOutputClientMessageSchema,
  mediaPlaySchema,
  type MediaCue,
  type MediaPlaybackCommand,
  type MediaOutputServerMessage,
  type MediaOutputSnapshot,
} from "./media-output";
import type { AutomationEvent } from "@/types/timecode";
import { compareAutomationCues } from "./automation-cues";

const outputSchema = z.object({
  name: z.string(),
  key: z.string(),
  leaseId: z.string(),
  until: z.number(),
  activeRequestId: z.string().nullable(),
  status: z.enum([
    "ready",
    "playing",
    "stopped",
    "ended",
    "error",
    "unconfirmed",
  ]),
  mediaName: z.string().nullable(),
  error: z.string().nullable(),
});
const attachmentSchema = z.object({
  media: z.object({ output: outputSchema.nullable() }),
});
type Output = z.infer<typeof outputSchema>;
type Receipt = {
  execution_id: string;
  fingerprint: string;
  request_id: string;
  lease_id: string;
  status: "pending" | "acknowledged" | "failed";
  action: MediaCue["action"];
  media_name: string | null;
  error: string | null;
};
interface Pending {
  socket: WebSocket;
  resolve: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

export function isMediaOutputSocket(socket: WebSocket): boolean {
  return attachmentSchema.safeParse(socket.deserializeAttachment()).success;
}
function readOutput(socket: WebSocket): Output | null {
  const parsed = attachmentSchema.safeParse(socket.deserializeAttachment());
  return parsed.success ? parsed.data.media.output : null;
}
function writeOutput(socket: WebSocket, output: Output | null): void {
  const attachment = z
    .record(z.string(), z.unknown())
    .parse(socket.deserializeAttachment());
  socket.serializeAttachment({ ...attachment, media: { output } });
}

/** One named output owner per show; durable receipts precede all socket effects. */
export class MediaOutputManager {
  private readonly pending = new Map<string, Pending>();
  private readonly arming = new Map<WebSocket, object>();
  constructor(
    private readonly options: {
      ctx: DurableObjectState;
      bucket: R2Bucket;
      authorize: (socket: WebSocket) => Promise<boolean>;
      changed: () => void;
    },
  ) {
    options.ctx.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS media_cue_receipts (
      execution_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request_id TEXT NOT NULL,
      lease_id TEXT NOT NULL, status TEXT NOT NULL, action TEXT NOT NULL, media_name TEXT, error TEXT
    )`);
  }

  private receipt(executionId: string): Receipt | null {
    return (
      this.options.ctx.storage.sql
        .exec<Receipt>(
          "SELECT * FROM media_cue_receipts WHERE execution_id=?",
          executionId,
        )
        .toArray()[0] ?? null
    );
  }

  private send(socket: WebSocket, message: MediaOutputServerMessage): void {
    if (
      socket.readyState !== WebSocket.OPEN ||
      !socketReadLeaseAllows(socket, true)
    )
      throw new Error(
        "Media output disconnected. Check the output before retrying.",
      );
    socket.send(JSON.stringify(message));
  }

  private owner(key: string) {
    for (const socket of this.options.ctx.getWebSockets()) {
      const output = readOutput(socket);
      if (socket.readyState === WebSocket.OPEN && output?.key === key)
        return { socket, output };
    }
    return null;
  }

  snapshot(): MediaOutputSnapshot[] {
    return this.options.ctx.getWebSockets().flatMap((socket) => {
      const output = readOutput(socket);
      if (!output || socket.readyState !== WebSocket.OPEN) return [];
      return [
        {
          name: output.name,
          status:
            output.until > Date.now()
              ? output.status
              : ("unconfirmed" as const),
          mediaName: output.mediaName,
          error: output.error,
        },
      ];
    });
  }

  plan(events: readonly AutomationEvent[]): void {
    const planned = [...events]
      .sort(compareAutomationCues)
      .filter(
        (event) =>
          event.enabled &&
          !event.fired &&
          !event.skipped &&
          event.action === "media-play",
      );
    for (const socket of this.options.ctx.getWebSockets()) {
      const output = readOutput(socket);
      if (!output || output.until <= Date.now()) continue;
      const media = planned
        .flatMap((event) => {
          const parsed = mediaPlaySchema.safeParse(event.payload);
          return parsed.success &&
            mediaOutputKey(parsed.data.output) === output.key
            ? [{ mediaId: parsed.data.mediaId, etag: parsed.data.etag }]
            : [];
        })
        .filter(
          (reference, index, all) =>
            all.findIndex(
              (other) =>
                other.mediaId === reference.mediaId &&
                other.etag === reference.etag,
            ) === index,
        )
        .slice(0, 2);
      try {
        this.send(socket, { type: "media-plan", media });
      } catch {
        this.disconnected(socket);
      }
    }
  }

  deadline(): number | null {
    const deadlines = this.options.ctx.getWebSockets().flatMap((socket) => {
      const output = readOutput(socket);
      return output && socket.readyState === WebSocket.OPEN
        ? [output.until]
        : [];
    });
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  expire(): void {
    for (const socket of this.options.ctx.getWebSockets()) {
      const output = readOutput(socket);
      if (output && output.until <= Date.now()) {
        this.disconnected(socket);
        socket.close(
          4408,
          "Media output heartbeat expired. Enable it again after reconnecting.",
        );
      }
    }
  }

  disconnected(socket: WebSocket): void {
    if (!isMediaOutputSocket(socket)) return;
    this.arming.delete(socket);
    writeOutput(socket, null);
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(
        new Error(
          "Media output disconnected before confirming the cue. Check playback before retrying.",
        ),
      );
    }
    this.options.changed();
  }

  clear(): void {
    for (const socket of this.options.ctx.getWebSockets())
      this.disconnected(socket);
    this.options.ctx.storage.sql.exec("DELETE FROM media_cue_receipts");
  }

  async message(socket: WebSocket, value: unknown): Promise<void> {
    const parsed = mediaOutputClientMessageSchema.safeParse(value);
    if (!parsed.success) {
      socket.close(4400, "Invalid media output message");
      this.disconnected(socket);
      return;
    }
    const message = parsed.data;
    if (!socketReadLeaseAllows(socket, true)) {
      this.disconnected(socket);
      return;
    }
    if (message.type === "media-ping") {
      const output = readOutput(socket);
      if (output && output.until <= Date.now()) {
        this.expire();
        return;
      }
      if (output)
        writeOutput(socket, {
          ...output,
          until: Date.now() + MEDIA_OUTPUT_LEASE_MS,
        });
      this.send(socket, {
        type: "media-pong",
        nonce: message.nonce,
        serverTime: Date.now(),
      });
      return;
    }
    if (message.type === "media-disarm") {
      this.disconnected(socket);
      this.send(socket, { type: "media-disarmed" });
      return;
    }
    const armAttempt = message.type === "media-arm" ? {} : null;
    if (armAttempt) this.arming.set(socket, armAttempt);
    const authorized = await this.options.authorize(socket);
    if (armAttempt) {
      // Disable/close wins even if the preceding permission read finishes late.
      if (this.arming.get(socket) !== armAttempt) return;
      this.arming.delete(socket);
    }
    if (!authorized || socket.readyState !== WebSocket.OPEN) {
      this.disconnected(socket);
      socket.close(4403, "Media output access changed");
      return;
    }
    if (message.type === "media-arm") {
      const key = mediaOutputKey(message.output);
      const owner = this.owner(key);
      if ((owner && owner.socket !== socket) || readOutput(socket)) {
        this.send(socket, {
          type: "media-rejected",
          requestId: message.requestId,
          error:
            "This output is already enabled. Disable its current window before enabling another.",
        });
        return;
      }
      if (this.snapshot().length >= 8) {
        this.send(socket, {
          type: "media-rejected",
          requestId: message.requestId,
          error: "This show already has eight enabled media outputs.",
        });
        return;
      }
      const leaseId = crypto.randomUUID();
      writeOutput(socket, {
        name: message.output,
        key,
        leaseId,
        until: Date.now() + MEDIA_OUTPUT_LEASE_MS,
        activeRequestId: null,
        status: "ready",
        mediaName: null,
        error: null,
      });
      this.send(socket, {
        type: "media-armed",
        requestId: message.requestId,
        output: message.output,
        leaseId,
        serverTime: Date.now(),
      });
      this.options.changed();
      return;
    }
    const output = readOutput(socket);
    const receipt = this.receipt(message.executionId);
    if (
      !output ||
      output.until <= Date.now() ||
      !receipt ||
      receipt.lease_id !== output.leaseId ||
      receipt.request_id !== message.requestId
    )
      return;
    if (message.type === "media-ended") {
      if (output.activeRequestId === message.requestId) {
        writeOutput(socket, {
          ...output,
          activeRequestId: null,
          status: message.error ? "error" : "ended",
          error: message.error ?? null,
        });
        this.options.changed();
      }
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (message.type === "media-unknown") {
      if (pending?.socket === socket) {
        this.pending.delete(message.requestId);
        pending.cleanup();
        pending.reject(
          new Error(
            "The output cannot confirm the previous media attempt. Check playback, then review and re-arm the cue.",
          ),
        );
      }
      return;
    }
    const result = message.result;
    if (
      result.ok &&
      result.state !== (receipt.action === "media-play" ? "playing" : "stopped")
    )
      return;
    // Keep the first terminal result. Delayed duplicates cannot rewrite history.
    if (receipt.status === "pending") {
      this.options.ctx.storage.sql.exec(
        "UPDATE media_cue_receipts SET status=?, error=? WHERE execution_id=? AND request_id=? AND status='pending'",
        result.ok ? "acknowledged" : "failed",
        result.ok ? null : result.error,
        message.executionId,
        message.requestId,
      );
      if (output.activeRequestId === message.requestId) {
        writeOutput(socket, {
          ...output,
          status: result.ok ? result.state : "error",
          mediaName:
            result.ok && result.state === "playing" ? receipt.media_name : null,
          error: result.ok ? null : result.error,
        });
        this.options.changed();
      }
    }
    if (pending?.socket === socket) {
      this.pending.delete(message.requestId);
      pending.cleanup();
      const saved = this.receipt(message.executionId);
      if (saved?.status === "acknowledged") pending.resolve();
      else pending.reject(new Error(saved?.error ?? "Media playback failed."));
    }
  }

  async execute(args: {
    orgId: string;
    eventId: string;
    executionId: string;
    cue: MediaCue;
    signal: AbortSignal;
    deadline: number;
    assertCanDispatch: () => void;
    authorizeDispatch: () => Promise<boolean>;
  }): Promise<void> {
    const { cue, executionId, signal, deadline, assertCanDispatch } = args;
    const key = mediaOutputKey(cue.payload.output);
    const fingerprint = JSON.stringify([
      args.eventId,
      cue.action,
      key,
      cue.action === "media-play"
        ? [cue.payload.mediaId, cue.payload.etag, cue.payload.volume]
        : null,
    ]);
    const previous = this.receipt(executionId);
    if (previous && previous.fingerprint !== fingerprint)
      throw new Error(
        "The media cue changed after an attempt. Review and re-arm it before firing again.",
      );
    if (previous?.status === "acknowledged") return;
    const owner = this.owner(key);
    if (!owner || owner.output.until <= Date.now())
      throw new Error(
        `Enable the “${cue.payload.output}” media output window before firing this cue.`,
      );
    let command: MediaPlaybackCommand = { action: "media-stop" };
    if (cue.action === "media-play" && previous?.status !== "pending") {
      const object = await this.options.bucket.head(
        mediaStorageKey(args.orgId, cue.payload.mediaId),
      );
      if (!object)
        throw new Error(
          "Media file is missing. Choose a file from the media library.",
        );
      const asset = mediaAssetSchema.parse({
        id: cue.payload.mediaId,
        name: object.customMetadata?.name,
        mimeType: object.httpMetadata?.contentType,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
        etag: object.httpEtag,
      });
      if (asset.etag !== cue.payload.etag)
        throw new Error(
          "The media file changed. Choose it again before firing this cue.",
        );
      command = { action: "media-play", asset, volume: cue.payload.volume };
    }
    if (!(await this.options.authorize(owner.socket))) {
      this.disconnected(owner.socket);
      owner.socket.close(4403, "Media output access changed");
      throw new Error(
        "Media output authorization expired. Sign in and enable it again.",
      );
    }
    if (!(await args.authorizeDispatch()))
      throw new Error(
        "Timecode control or permission changed before media dispatch.",
      );
    assertCanDispatch();
    signal.throwIfAborted();
    const current = this.owner(key);
    if (
      !current ||
      current.socket !== owner.socket ||
      current.output.leaseId !== owner.output.leaseId ||
      current.output.until <= Date.now()
    )
      throw new Error(
        "Media output changed before dispatch. Check the output and retry.",
      );
    if (deadline <= Date.now())
      throw new Error("Media cue expired before dispatch.");
    if (
      previous?.status === "pending" &&
      previous.lease_id !== current.output.leaseId
    )
      throw new Error(
        "The previous media attempt belongs to another output session. Check playback, then review and re-arm this cue.",
      );
    const requestId =
      previous?.status === "pending"
        ? previous.request_id
        : crypto.randomUUID();
    const querying = previous?.status === "pending";
    if (!querying) {
      this.options.ctx.storage.sql.exec(
        `INSERT INTO media_cue_receipts (execution_id,fingerprint,request_id,lease_id,status,action,media_name,error)
        VALUES (?,?,?,?,'pending',?,?,NULL) ON CONFLICT(execution_id) DO UPDATE SET request_id=excluded.request_id, lease_id=excluded.lease_id, status='pending', error=NULL`,
        executionId,
        fingerprint,
        requestId,
        current.output.leaseId,
        cue.action,
        command.action === "media-play" ? command.asset.name : null,
      );
      writeOutput(current.socket, {
        ...current.output,
        activeRequestId: requestId,
      });
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", cancel);
      const cancel = () => {
        this.pending.delete(requestId);
        cleanup();
        try {
          if (!querying)
            this.send(current.socket, {
              type: "media-cancel",
              executionId,
              requestId,
            });
        } catch {
          /* The receipt remains uncertain. */
        }
        reject(
          new Error(
            "Media cue timed out before confirmation. Check the output before retrying.",
          ),
        );
      };
      this.pending.set(requestId, {
        socket: current.socket,
        resolve,
        reject,
        cleanup,
      });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        this.send(
          current.socket,
          querying
            ? { type: "media-query", executionId, requestId }
            : {
                type: "media-execute",
                executionId,
                requestId,
                leaseId: current.output.leaseId,
                deadline,
                command,
              },
        );
      } catch (error) {
        this.pending.delete(requestId);
        cleanup();
        reject(error);
      }
    });
  }
}
