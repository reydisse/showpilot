import { chatAttachmentSchema, chatUploadAttachment, chatUploadSpecSchema, type ChatAttachment, type ChatUploadSpec } from "./chat-attachment";

type WorkIdentity = { id: string; name: string; at: number };
export type ChatAttachmentWork = WorkIdentity & (
  | { state: "preparing" | "uploading" | "removing" }
  | { state: "upload-failed" | "remove-failed"; error: string }
  | { state: "ready" | "sending"; attachment: ChatAttachment }
);
export type PreparedChatAttachment<Body> = { spec: ChatUploadSpec; body: Body };
type Transfer<Source, Body> = {
  orgId: string;
  capacity: number;
  newId: () => string;
  prepare: (source: Source, id: string, signal: AbortSignal) => Promise<PreparedChatAttachment<Body>>;
  upload: (prepared: PreparedChatAttachment<Body>, signal: AbortSignal) => Promise<unknown>;
  cancel: (spec: ChatUploadSpec, signal: AbortSignal) => Promise<void>;
};
type Entry<Source, Body> = {
  source: Source;
  work: ChatAttachmentWork;
  prepared?: PreparedChatAttachment<Body>;
  controller?: AbortController;
};

/** One instance belongs to one account, organization and conversation. Keep it
 * outside mounted views: leaving a room never implicitly deletes its draft.
 * Source bytes/URIs remain available until explicit removal or local outbox
 * acceptance. Retries keep the same upload ID, checksum and prepared content. */
export class ChatAttachmentDraft<Source, Body> {
  private entries = new Map<string, Entry<Source, Body>>();
  private listeners = new Set<() => void>();
  private snapshot: ChatAttachmentWork[] = [];
  constructor(private readonly transfer: Transfer<Source, Body>) {}

  getSnapshot = (): ChatAttachmentWork[] => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish() {
    this.snapshot = [...this.entries.values()].map(entry => entry.work);
    for (const listener of this.listeners) listener();
  }
  private transition(entry: Entry<Source, Body>, work: ChatAttachmentWork) {
    entry.work = work;
    this.publish();
  }
  private identity(entry: Entry<Source, Body>): WorkIdentity {
    return { id: entry.work.id, name: entry.prepared?.spec.name ?? entry.work.name, at: Date.now() };
  }

  add(source: Source, name: string): string {
    if (this.entries.size >= this.transfer.capacity) throw new Error(`You can attach up to ${this.transfer.capacity} files. Remove or send an existing attachment first.`);
    const id = this.transfer.newId();
    const entry: Entry<Source, Body> = { source, work: { id, name, state: "preparing", at: Date.now() } };
    this.entries.set(id, entry);
    this.publish();
    void this.upload(entry);
    return id;
  }

  retry(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.work.state === "upload-failed") void this.upload(entry);
    else if (entry?.work.state === "remove-failed") this.remove(id);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.work.state === "sending" || entry.work.state === "removing") return;
    entry.controller?.abort();
    if (!entry.prepared) {
      // Preparation is forbidden from publishing bytes. A late preparer is
      // ignored; no server cancellation is necessary before upload begins.
      this.entries.delete(id);
      this.publish();
      return;
    }
    const controller = new AbortController();
    entry.controller = controller;
    this.transition(entry, { ...this.identity(entry), state: "removing" });
    const spec = entry.prepared.spec;
    void attachmentDeadline(() => this.transfer.cancel(spec, controller.signal), controller, 15_000,
      "Removal was not confirmed. Retry removing this attachment.").then(() => {
      if (entry.controller !== controller) return;
      this.entries.delete(id);
      this.publish();
    }).catch(error => {
      if (entry.controller !== controller) return;
      this.transition(entry, { ...this.identity(entry), state: "remove-failed", error: message(error, "Attachment could not be removed. Retry removal.") });
    });
  }

  private async upload(entry: Entry<Source, Body>): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    this.transition(entry, { ...this.identity(entry), state: entry.prepared ? "uploading" : "preparing" });
    const current = () => !controller.signal.aborted && this.entries.get(entry.work.id) === entry && entry.controller === controller;
    try {
      const attachment = await attachmentDeadline(async () => {
        if (!entry.prepared) {
          const prepared = await this.transfer.prepare(entry.source, entry.work.id, controller.signal);
          if (!current()) throw new Error("Attachment preparation cancelled");
          const spec = chatUploadSpecSchema.parse(prepared.spec);
          if (spec.uploadId !== entry.work.id) throw new Error("Upload identity changed during preparation. Remove this attachment and choose it again.");
          entry.prepared = { ...prepared, spec };
          this.transition(entry, { ...this.identity(entry), state: "uploading" });
        }
        if (!current()) throw new Error("Upload cancelled");
        const value = await this.transfer.upload(entry.prepared, controller.signal);
        const actual = chatAttachmentSchema.parse(value);
        const expected = chatUploadAttachment(this.transfer.orgId, entry.prepared.spec);
        if (actual.id !== expected.id || actual.name !== expected.name || actual.url !== expected.url || actual.mimeType !== expected.mimeType || actual.size !== expected.size) throw new Error("The upload reply does not match this file. Recover the original upload.");
        return actual;
      }, controller, 60_000, "Upload was not confirmed. Retry this file to recover the original upload.");
      if (!current()) return;
      this.transition(entry, { ...this.identity(entry), state: "ready", attachment });
    } catch (error) {
      // Timeout aborts the signal but still needs a visible failure. Explicit
      // removal replaces the controller or removes the entry altogether.
      if (this.entries.get(entry.work.id) !== entry || entry.controller !== controller) return;
      this.transition(entry, { ...this.identity(entry), state: "upload-failed", error: message(error, "Upload was not confirmed. Retry this file.") });
    }
  }

  /** Ownership transfers only when the local outbox accepts the message.
   * This callback must enqueue locally, never wait for network delivery. */
  async handoff(enqueue: (attachments: ChatAttachment[]) => void | Promise<void>): Promise<void> {
    if (this.snapshot.some(work => work.state !== "ready")) throw new Error("Finish or remove pending attachments before sending.");
    const selected = [...this.entries.values()].map(entry => {
      if (entry.work.state !== "ready") throw new Error("Attachment is not ready");
      return { entry, attachment: entry.work.attachment };
    });
    for (const { entry, attachment } of selected) entry.work = { ...this.identity(entry), state: "sending", attachment };
    this.publish();
    try {
      await enqueue(selected.map(item => item.attachment));
      for (const { entry } of selected) this.entries.delete(entry.work.id);
    } catch (error) {
      for (const { entry, attachment } of selected) entry.work = { ...this.identity(entry), state: "ready", attachment };
      throw error;
    } finally { this.publish(); }
  }
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Promise.race also bounds APIs that ignore AbortSignal (pickers, native file
 * preparation, response parsing). Callers must check the signal before writes. */
export async function attachmentDeadline<T>(task: () => Promise<T>, controller: AbortController, milliseconds: number, error: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  if (controller.signal.aborted) throw new Error("Attachment operation cancelled");
  try {
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Attachment operation cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => { reject(new Error(error)); controller.abort(); }, milliseconds);
    });
    return await Promise.race([task(), stopped]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
