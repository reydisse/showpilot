import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAttachmentDraft, type PreparedChatAttachment } from "@showpilot/shared/chat-attachment-draft";
import { chatUploadAttachment, type ChatUploadSpec, type ChatAttachment } from "@showpilot/shared/chat-attachment";

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(capacity = 6) {
  const prepare = vi.fn(async (source: string, id: string): Promise<PreparedChatAttachment<string>> => ({
    spec: { uploadId: id, name: source, mimeType: "text/plain", size: 5, sha256: "a".repeat(64) }, body: `bytes:${source}`,
  }));
  const upload = vi.fn(async (prepared: PreparedChatAttachment<string>) => chatUploadAttachment("org", prepared.spec));
  const cancel = vi.fn(async (_spec: ChatUploadSpec, _signal: AbortSignal) => {});
  const draft = new ChatAttachmentDraft({ orgId: "org", capacity, newId: () => crypto.randomUUID(), prepare, upload, cancel });
  return { draft, prepare, upload, cancel };
}
afterEach(() => vi.useRealTimers());

describe("retained attachment draft", () => {
  it("keeps source, identity and timestamp after a lost reply, then recovers the same upload", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.upload.mockImplementationOnce(() => new Promise(() => {}));
    const id = f.draft.add("notes.txt", "notes.txt");
    await settle();
    expect(f.draft.getSnapshot()[0].state).toBe("uploading");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "upload-failed", at: Date.now(), error: expect.stringContaining("not confirmed") });
    f.draft.retry(id); await settle();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.upload).toHaveBeenCalledTimes(2);
    expect(f.upload.mock.calls[0][0]).toBe(f.upload.mock.calls[1][0]);
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "ready" });
  });

  it("never publishes bytes from preparation that finishes after its deadline", async () => {
    vi.useFakeTimers(); const f = fixture();
    const prepared = deferred<PreparedChatAttachment<string>>();
    f.prepare.mockReturnValueOnce(prepared.promise);
    const id = f.draft.add("notes.txt", "notes.txt");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.draft.getSnapshot()[0].state).toBe("upload-failed");
    prepared.resolve({ spec: { uploadId: id, name: "notes.txt", mimeType: "text/plain", size: 5, sha256: "a".repeat(64) }, body: "bytes" });
    await settle(); expect(f.upload).not.toHaveBeenCalled();
    f.draft.remove(id); expect(f.draft.getSnapshot()).toEqual([]); expect(f.cancel).not.toHaveBeenCalled();
  });

  it("preserves an attachment-specific removal failure and retries the same cancellation", async () => {
    const f = fixture(); const id = f.draft.add("notes.txt", "notes.txt"); await settle();
    f.cancel.mockRejectedValueOnce(new Error("Storage unavailable"));
    f.draft.remove(id); await settle();
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "remove-failed", error: "Storage unavailable" });
    await expect(f.draft.handoff(() => {})).rejects.toThrow("pending attachments");
    f.draft.retry(id); await settle();
    expect(f.cancel.mock.calls[0][0]).toEqual(f.cancel.mock.calls[1][0]);
    expect(f.draft.getSnapshot()).toEqual([]);
  });

  it("bounds a hung removal and retains a retry", async () => {
    vi.useFakeTimers(); const f = fixture();
    const id = f.draft.add("notes.txt", "notes.txt"); await settle();
    f.cancel.mockImplementationOnce(() => new Promise(() => {}));
    f.draft.remove(id); await vi.advanceTimersByTimeAsync(15_000);
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "remove-failed", error: expect.stringContaining("not confirmed") });
    f.draft.retry(id); await settle(); expect(f.draft.getSnapshot()).toEqual([]);
  });

  it("cancels an uncertain upload and ignores its late successful response", async () => {
    const f = fixture(); const reply = deferred<ReturnType<typeof chatUploadAttachment>>();
    f.upload.mockReturnValueOnce(reply.promise);
    const id = f.draft.add("notes.txt", "notes.txt"); await settle();
    const spec = f.upload.mock.calls[0][0].spec;
    f.draft.remove(id); await settle();
    expect(f.cancel).toHaveBeenCalledWith(spec, expect.any(AbortSignal));
    reply.resolve(chatUploadAttachment("org", spec)); await settle();
    expect(f.draft.getSnapshot()).toEqual([]);
  });

  it("retains work across view subscriptions without deleting the draft", async () => {
    const f = fixture(); const first = vi.fn(), second = vi.fn();
    const unsubscribe = f.draft.subscribe(first);
    const id = f.draft.add("notes.txt", "notes.txt"); unsubscribe();
    await settle(); const unsubscribeSecond = f.draft.subscribe(second);
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "ready" });
    expect(f.cancel).not.toHaveBeenCalled();
    f.draft.remove(id); await settle(); expect(second).toHaveBeenCalled(); unsubscribeSecond();
  });

  it("reserves capacity before preparation and never silently drops excess files", async () => {
    const f = fixture(1); f.prepare.mockReturnValueOnce(new Promise(() => {}));
    const id = f.draft.add("first.txt", "first.txt");
    expect(() => f.draft.add("second.txt", "second.txt")).toThrow("up to 1 files");
    expect(f.draft.getSnapshot()).toHaveLength(1); f.draft.remove(id);
  });

  it("protects files during outbox acceptance and consumes only the submitted snapshot", async () => {
    const f = fixture(); const first = f.draft.add("first.txt", "first.txt"); await settle();
    const accepted = deferred<void>(); const enqueue = vi.fn((_attachments: ChatAttachment[]) => accepted.promise);
    const sending = f.draft.handoff(enqueue);
    f.draft.remove(first); expect(f.cancel).not.toHaveBeenCalled();
    expect(f.draft.getSnapshot()[0].state).toBe("sending");
    const second = f.draft.add("second.txt", "second.txt"); await settle();
    accepted.resolve(); await sending;
    expect(f.draft.getSnapshot()).toMatchObject([{ id: second, state: "ready" }]);
    expect(enqueue.mock.calls[0][0]).toMatchObject([{ id: first }]);
  });

  it("restores the same ready attachments when the local outbox rejects a message", async () => {
    const f = fixture(); const id = f.draft.add("notes.txt", "notes.txt"); await settle();
    await expect(f.draft.handoff(() => { throw new Error("Queue full"); })).rejects.toThrow("Queue full");
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "ready" }); expect(f.cancel).not.toHaveBeenCalled();
  });

  it("rejects an upload reply for another room's file instead of attaching it", async () => {
    const f = fixture();
    f.upload.mockImplementationOnce(async prepared => chatUploadAttachment("other-org", prepared.spec));
    const id = f.draft.add("notes.txt", "notes.txt"); await settle();
    expect(f.draft.getSnapshot()[0]).toMatchObject({ id, state: "upload-failed", error: expect.stringContaining("does not match") });
    f.draft.retry(id); await settle(); expect(f.draft.getSnapshot()[0].state).toBe("ready");
  });
});
