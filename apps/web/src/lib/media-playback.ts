import { MAX_MEDIA_BYTES, mediaLibraryUrl } from "./media-library";
import { createBrowserId } from "./browser-id";
import {
  MEDIA_OUTPUT_LEASE_MS,
  MEDIA_OUTPUT_PING_MS,
  mediaOutputServerMessageSchema,
  type MediaOutputClientMessage,
  type MediaOutputServerMessage,
  type MediaReference,
  type MediaResult,
} from "./media-output";

type ExecuteMessage = Extract<
  MediaOutputServerMessage,
  { type: "media-execute" }
>;
type CachedMedia = { url: string; bytes: number };
const referenceKey = (reference: MediaReference) =>
  JSON.stringify([reference.mediaId, reference.etag]);
const MAX_CACHE_BYTES = MAX_MEDIA_BYTES * 2;

/** Server time upper bound from a request/response, anchored to a monotonic clock. */
export class MediaDeadlineClock {
  private anchor: { serverUpper: number; received: number } | null = null;
  sample(serverTime: number, sent: number, received = performance.now()): void {
    this.anchor = {
      serverUpper: serverTime + Math.max(0, received - sent),
      received,
    };
  }
  remaining(deadline: number, now = performance.now()): number {
    return this.anchor
      ? deadline -
          this.anchor.serverUpper -
          Math.max(0, now - this.anchor.received)
      : 0;
  }
}

function silenceUrl(): string {
  const buffer = new ArrayBuffer(44 + 800);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const text = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 800, true);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Media operation cancelled."));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function waitForMediaState(
  video: HTMLVideoElement,
  ready: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearInterval(interval);
      signal.removeEventListener("abort", check);
    };
    const check = () => {
      if (signal.aborted) {
        cleanup();
        reject(
          signal.reason ?? new Error("Media cue expired before confirmation."),
        );
      } else if (ready()) {
        cleanup();
        resolve();
      } else if (video.error) {
        cleanup();
        reject(new Error("This computer cannot decode the media file."));
      }
    };
    const interval = setInterval(check, 20);
    signal.addEventListener("abort", check, { once: true });
    check();
  });
}

export type MediaPlayerStatus = {
  kind: "connecting" | "disabled" | "enabling" | "enabled" | "disconnected";
  message: string;
};

/** Owns one permanent HTML element, its lease, cache, and per-attempt receipts. */
export class MediaPlaybackSession {
  private socket: WebSocket | null = null;
  private enabledLease: string | null = null;
  private readonly clock = new MediaDeadlineClock();
  private readonly pings = new Map<string, number>();
  private leaseUntil = 0;
  private connectedAt = 0;
  private armRequest: { id: string; sent: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextPing = 0;
  private readonly cache = new Map<string, CachedMedia>();
  private readonly loading = new Map<string, Promise<CachedMedia>>();
  private preload = new AbortController();
  private plan = "";
  private active: {
    requestId: string;
    executionId: string;
    key: string;
  } | null = null;
  private command: { requestId: string; controller: AbortController } | null =
    null;
  private readonly receipts = new Map<
    string,
    { executionId: string; result: Promise<MediaResult> }
  >();
  private disposed = false;
  private reservedBytes = 0;

  constructor(
    private readonly options: {
      video: HTMLVideoElement;
      orgId: string;
      showId: string;
      output: string;
      status: (status: MediaPlayerStatus) => void;
      preparation: (message: string) => void;
    },
  ) {
    options.video.addEventListener("ended", this.ended);
    options.video.addEventListener("error", this.failed);
  }

  connect(): void {
    if (this.disposed || this.socket) return;
    const url = new URL(
      `/api/timecode/${encodeURIComponent(this.options.orgId)}/media-ws`,
      location.href,
    );
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("showId", this.options.showId);
    this.connectedAt = performance.now();
    this.options.status({
      kind: "connecting",
      message: "Connecting to this show's media output…",
    });
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      try {
        const message = mediaOutputServerMessageSchema.parse(
          JSON.parse(String(event.data)),
        );
        this.receive(message);
      } catch {
        this.disconnect(
          "Invalid output response. Reconnect and enable the output again.",
        );
      }
    };
    socket.onclose = () => {
      if (this.socket === socket)
        this.disconnect(
          "Disconnected. Playback stopped. Reconnect and enable this output again.",
        );
    };
    socket.onerror = () => {
      if (this.socket === socket)
        this.disconnect(
          "Could not connect. Check your sign-in, show and connection, then retry.",
        );
    };
    this.timer = setInterval(() => {
      const now = performance.now();
      if (this.enabledLease && now >= this.leaseUntil) {
        this.disconnect(
          "Output heartbeat expired. Playback stopped. Reconnect and enable it again.",
        );
        return;
      }
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        if (now - this.connectedAt > 10_000)
          this.disconnect(
            "Connection timed out. Check your sign-in and retry.",
          );
        return;
      }
      if (this.armRequest && now - this.armRequest.sent > 10_000) {
        this.disconnect(
          "Output enablement was not confirmed. Reconnect and try again.",
        );
        return;
      }
      if (now < this.nextPing) return;
      const nonce = createBrowserId();
      this.pings.set(nonce, now);
      this.nextPing = now + MEDIA_OUTPUT_PING_MS;
      for (const [key, sent] of this.pings)
        if (now - sent > MEDIA_OUTPUT_LEASE_MS) this.pings.delete(key);
      this.send({ type: "media-ping", nonce });
    }, 200);
  }

  private send(message: MediaOutputClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  async enable(): Promise<void> {
    if (
      this.enabledLease ||
      this.armRequest ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    const socket = this.socket;
    const request = { id: createBrowserId(), sent: performance.now() };
    this.armRequest = request;
    this.options.status({
      kind: "enabling",
      message: "Enabling playback on this computer…",
    });
    // play() is called synchronously from the click on this same permanent
    // element. The silent WAV unlocks audible playback in Safari and Chromium.
    const url = silenceUrl();
    const video = this.options.video;
    try {
      video.src = url;
      video.muted = false;
      video.volume = 1;
      await abortable(video.play(), AbortSignal.timeout(5000));
      if (
        this.disposed ||
        this.socket !== socket ||
        this.armRequest !== request ||
        socket.readyState !== WebSocket.OPEN
      )
        return;
      video.pause();
      video.removeAttribute("src");
      video.load();
      request.sent = performance.now();
      this.send({
        type: "media-arm",
        output: this.options.output,
        requestId: request.id,
      });
    } catch {
      if (this.armRequest !== request) return;
      this.armRequest = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
      this.options.status({
        kind: "disabled",
        message:
          "This browser blocked media playback. Enable sound for this site, then try Enable output again.",
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  disable(): void {
    this.enabledLease = null;
    this.armRequest = null;
    this.stop();
    this.clearCache();
    this.send({ type: "media-disarm" });
    this.options.status({
      kind: "disabled",
      message: "Output disabled. Playback stopped.",
    });
  }

  private receive(message: MediaOutputServerMessage): void {
    switch (message.type) {
      case "media-hello":
        if (
          message.orgId !== this.options.orgId ||
          message.showId !== this.options.showId
        ) {
          this.disconnect("Output show mismatch.");
          return;
        }
        this.clock.sample(message.serverTime, this.connectedAt);
        this.options.status({
          kind: "disabled",
          message:
            "Enable this output on the computer connected to your screen or audio system.",
        });
        break;
      case "media-armed": {
        if (!this.armRequest || message.requestId !== this.armRequest.id)
          return;
        this.clock.sample(message.serverTime, this.armRequest.sent);
        this.leaseUntil = this.armRequest.sent + MEDIA_OUTPUT_LEASE_MS;
        this.armRequest = null;
        this.enabledLease = message.leaseId;
        this.options.status({
          kind: "enabled",
          message: `“${message.output}” is enabled for this show.`,
        });
        break;
      }
      case "media-rejected":
        this.armRequest = null;
        this.enabledLease = null;
        this.stop();
        this.options.status({ kind: "disabled", message: message.error });
        break;
      case "media-disarmed":
        this.enabledLease = null;
        this.armRequest = null;
        this.stop();
        break;
      case "media-pong": {
        const sent = this.pings.get(message.nonce);
        if (sent === undefined) return;
        this.pings.delete(message.nonce);
        this.clock.sample(message.serverTime, sent);
        if (this.enabledLease) this.leaseUntil = sent + MEDIA_OUTPUT_LEASE_MS;
        break;
      }
      case "media-plan":
        if (this.enabledLease) void this.prepare(message.media);
        break;
      case "media-query": {
        const receipt = this.receipts.get(message.requestId);
        if (!receipt || receipt.executionId !== message.executionId)
          this.send({
            type: "media-unknown",
            executionId: message.executionId,
            requestId: message.requestId,
          });
        else
          void receipt.result.then((result) =>
            this.send({
              type: "media-result",
              executionId: message.executionId,
              requestId: message.requestId,
              result,
            }),
          );
        break;
      }
      case "media-cancel":
        if (this.command?.requestId === message.requestId)
          this.command.controller.abort(
            new Error("Cue expired before confirmation."),
          );
        if (this.active?.requestId === message.requestId) {
          this.ended("The cue expired before confirmation. Playback stopped.");
          this.stop();
        }
        break;
      case "media-execute": {
        const previous = this.receipts.get(message.requestId);
        if (previous) {
          if (previous.executionId === message.executionId)
            void previous.result.then((result) =>
              this.send({
                type: "media-result",
                executionId: message.executionId,
                requestId: message.requestId,
                result,
              }),
            );
          return;
        }
        const result = this.execute(message);
        this.receipts.set(message.requestId, {
          executionId: message.executionId,
          result,
        });
        while (this.receipts.size > 512) {
          const first = this.receipts.keys().next();
          if (first.done) break;
          this.receipts.delete(first.value);
        }
        void result.then((result) =>
          this.send({
            type: "media-result",
            executionId: message.executionId,
            requestId: message.requestId,
            result,
          }),
        );
        break;
      }
    }
  }

  private async prepare(media: MediaReference[]): Promise<void> {
    const signature = JSON.stringify(media);
    if (signature === this.plan) return;
    this.plan = signature;
    const signal = this.preload.signal;
    const protectedKeys = new Set(media.map(referenceKey));
    this.options.preparation(
      media.length ? "Preparing upcoming media…" : "No upcoming media cues.",
    );
    try {
      for (const reference of media) {
        if (signal.aborted || this.plan !== signature) return;
        await this.load(reference, signal, protectedKeys);
      }
      if (!signal.aborted && this.plan === signature)
        this.options.preparation(
          media.length
            ? `${media.length} upcoming clip${media.length === 1 ? "" : "s"} prepared.`
            : "No upcoming media cues.",
        );
    } catch (error) {
      if (!signal.aborted && this.plan === signature) {
        this.plan = "";
        this.options.preparation(
          error instanceof Error
            ? error.message
            : "Could not prepare media. Check the connection.",
        );
      }
    }
  }

  private async load(
    reference: MediaReference,
    signal: AbortSignal,
    protectedKeys = new Set<string>(),
  ): Promise<CachedMedia> {
    const key = referenceKey(reference);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const loading = this.loading.get(key);
    if (loading) return abortable(loading, signal);
    const operation = (async () => {
      const response = await fetch(
        mediaLibraryUrl(this.options.orgId, reference.mediaId),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) },
      );
      if (!response.ok)
        throw new Error(
          `Media could not load (${response.status}). Check sign-in and the media library.`,
        );
      if (response.headers.get("etag") !== reference.etag) {
        await response.body?.cancel();
        throw new Error(
          "The media file changed. Choose it again in the cue editor.",
        );
      }
      const size = Number(response.headers.get("content-length"));
      if (!Number.isSafeInteger(size) || size < 12 || size > MAX_MEDIA_BYTES) {
        await response.body?.cancel();
        throw new Error("Invalid media file size.");
      }
      let total =
        this.reservedBytes +
        [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [oldKey, old] of this.cache) {
        if (total + size <= MAX_CACHE_BYTES) break;
        if (oldKey === this.active?.key || protectedKeys.has(oldKey)) continue;
        this.cache.delete(oldKey);
        URL.revokeObjectURL(old.url);
        total -= old.bytes;
      }
      if (total + size > MAX_CACHE_BYTES) {
        await response.body?.cancel();
        throw new Error(
          "Upcoming clip needs more buffer space. It will load when the current clip stops.",
        );
      }
      this.reservedBytes += size;
      try {
        const blob = await response.blob();
        signal.throwIfAborted();
        if (blob.size !== size)
          throw new Error("Media download was incomplete. Retry preparation.");
        const media = { url: URL.createObjectURL(blob), bytes: blob.size };
        this.cache.set(key, media);
        return media;
      } finally {
        this.reservedBytes -= size;
      }
    })();
    this.loading.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.loading.get(key) === operation) this.loading.delete(key);
    }
  }

  private async execute(message: ExecuteMessage): Promise<MediaResult> {
    if (
      !this.enabledLease ||
      this.enabledLease !== message.leaseId ||
      performance.now() >= this.leaseUntil
    )
      return {
        ok: false,
        error: "Output is not enabled. Enable it before retrying.",
      };
    const remaining = this.clock.remaining(message.deadline);
    if (remaining <= 0)
      return {
        ok: false,
        error: "Media cue arrived after its deadline. It was not played.",
      };
    this.command?.controller.abort(
      new Error("A newer media cue replaced this attempt."),
    );
    const controller = new AbortController();
    this.command = { requestId: message.requestId, controller };
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
    ]);
    const video = this.options.video;
    try {
      if (message.command.action === "media-stop") {
        this.stop(false);
        // currentSrc can retain the previous URL after load() unloads the clip.
        // Confirm the playback/decoder state after resource selection settles.
        await waitForMediaState(
          video,
          () =>
            video.paused &&
            video.readyState === HTMLMediaElement.HAVE_NOTHING &&
            video.networkState === HTMLMediaElement.NETWORK_EMPTY &&
            !video.hasAttribute("src") &&
            video.srcObject === null,
          signal,
        );
        return { ok: true, state: "stopped" };
      }
      const reference = {
        mediaId: message.command.asset.id,
        etag: message.command.asset.etag,
      };
      const media = await this.load(reference, signal);
      signal.throwIfAborted();
      if (
        !this.enabledLease ||
        this.enabledLease !== message.leaseId ||
        this.clock.remaining(message.deadline) <= 0
      )
        throw new Error("Media cue expired while loading. It was not played.");
      video.pause();
      video.src = media.url;
      video.muted = false;
      video.volume = message.command.volume;
      this.active = {
        requestId: message.requestId,
        executionId: message.executionId,
        key: referenceKey(reference),
      };
      await abortable(video.play(), signal);
      await waitForMediaState(
        video,
        () =>
          video.currentTime > 0 &&
          (video.ended || (!video.paused && video.readyState >= 2)),
        signal,
      );
      return { ok: true, state: "playing" };
    } catch (error) {
      if (
        this.command?.requestId === message.requestId &&
        (!this.active || this.active.requestId === message.requestId)
      )
        this.stop(false);
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Media playback failed.",
      };
    } finally {
      if (this.command?.requestId === message.requestId) this.command = null;
    }
  }

  private ended = (error?: unknown): void => {
    if (
      !this.active ||
      (typeof error !== "string" && !this.options.video.ended)
    )
      return;
    this.send({
      type: "media-ended",
      executionId: this.active.executionId,
      requestId: this.active.requestId,
      ...(typeof error === "string" ? { error } : {}),
    });
    this.active = null;
  };
  private failed = (): void => {
    if (this.active && this.options.video.error)
      this.ended(
        "Media playback failed after starting. Check the file and output computer.",
      );
  };
  private stop(abort = true): void {
    if (abort)
      this.command?.controller.abort(new Error("Media output stopped."));
    this.active = null;
    const video = this.options.video;
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
  private clearCache(): void {
    this.preload.abort();
    this.preload = new AbortController();
    this.plan = "";
    for (const media of this.cache.values()) URL.revokeObjectURL(media.url);
    this.cache.clear();
    this.loading.clear();
    this.options.preparation("");
  }
  private disconnect(message: string): void {
    const socket = this.socket;
    this.socket = null;
    this.enabledLease = null;
    this.armRequest = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stop();
    this.clearCache();
    this.pings.clear();
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    if (!this.disposed) this.options.status({ kind: "disconnected", message });
  }
  dispose(): void {
    this.disposed = true;
    this.disconnect("");
    this.options.video.removeEventListener("ended", this.ended);
    this.options.video.removeEventListener("error", this.failed);
  }
}
