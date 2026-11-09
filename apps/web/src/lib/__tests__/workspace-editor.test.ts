import { afterEach, expect, it, vi } from "vitest";
import { resolveWorkspaceProfile } from "@showpilot/shared";
import { WorkspaceEditor } from "@showpilot/shared/workspace-editor";
import type { WorkspaceChange, WorkspaceChangeResult } from "@showpilot/shared/workspace-change";
const scope = { orgId: "workspace", userId: "owner" };
const profile = resolveWorkspaceProfile({ "workspace-type": "custom" });
const snapshot = { ...scope, revision: null, profile };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const read = vi.fn(async () => snapshot);
  const send = vi.fn(async (command: WorkspaceChange, _mode: "save" | "review", _signal: AbortSignal): Promise<WorkspaceChangeResult> => ({ ...scope, requestId: command.requestId, outcome: "applied", snapshot }));
  const refresh = vi.fn(async () => {});
  const editor = new WorkspaceEditor(scope, profile, { read, send, refresh, uuid: () => crypto.randomUUID() });
  return { editor, read, send, refresh };
}
afterEach(() => vi.useRealTimers());
it("preserves names being edited when a fresh snapshot arrives", async () => {
  const f = fixture(); await f.editor.load();
  f.editor.edit({ ...f.editor.getSnapshot().draft, custom: { label: "In progress", terms: { event: "Gig", events: "Gigs", item: "Act", items: "Acts" } } });
  await f.editor.load();
  expect(f.editor.getSnapshot().draft.custom.label).toBe("In progress");
});
it("bounds a hung initial read and allows an explicit reload", async () => {
  vi.useFakeTimers(); const f = fixture();
  f.read.mockReturnValueOnce(new Promise(() => {}));
  const pending = f.editor.load(); await vi.advanceTimersByTimeAsync(12000); await pending;
  expect(f.editor.getSnapshot()).toMatchObject({ loading: false, error: "Workspace request timed out." });
  await f.editor.load(); expect(f.editor.getSnapshot().snapshot).toEqual(snapshot);
});
it("keeps the exact unknown request, ignores a late reply and prevents duplicate submissions", async () => {
  vi.useFakeTimers(); const f = fixture(); await f.editor.load();
  const pending = deferred<WorkspaceChangeResult>(); f.send.mockReturnValueOnce(pending.promise);
  f.editor.submit({ kind: "module", module: "chat", enabled: false });
  f.editor.submit({ kind: "module", module: "songs", enabled: false });
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.send).toHaveBeenCalledTimes(1);
  const command = f.send.mock.calls[0][0];
  expect(f.editor.getSnapshot().attempt?.kind).toBe("unknown");
  pending.resolve({ ...scope, requestId: command.requestId, outcome: "applied", snapshot });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.editor.getSnapshot().attempt?.kind).toBe("unknown");
  f.editor.retry(); await vi.advanceTimersByTimeAsync(0);
  expect(f.send.mock.calls[1][0]).toEqual(command);
  expect(f.editor.getSnapshot()).toMatchObject({ attempt: null, notice: "Workspace saved." });
});
it("review fences the original uncertain command instead of inventing another request", async () => {
  const f = fixture(); await f.editor.load(); f.send.mockRejectedValueOnce(new Error("Lost reply"));
  f.editor.submit({ kind: "module", module: "chat", enabled: false });
  await vi.waitFor(() => expect(f.editor.getSnapshot().attempt?.kind).toBe("unknown"));
  f.send.mockImplementationOnce(async command => ({ ...scope, requestId: command.requestId, outcome: "cancelled", snapshot }));
  f.editor.review();
  await vi.waitFor(() => expect(f.editor.getSnapshot().attempt).toMatchObject({ kind: "confirmed", refresh: "done", result: { outcome: "cancelled" } }));
  expect(f.send.mock.calls[1].slice(0, 2)).toEqual([f.send.mock.calls[0][0], "review"]);
  f.editor.useCurrent(); expect(f.editor.getSnapshot().attempt).toBeNull();
});
it("retries only a failed refresh after the save is already confirmed", async () => {
  const f = fixture(); await f.editor.load(); f.refresh.mockRejectedValueOnce(new Error("Offline"));
  f.editor.submit({ kind: "type", type: "school", resetModules: false });
  await vi.waitFor(() => expect(f.editor.getSnapshot().attempt).toMatchObject({ kind: "confirmed", refresh: "failed" }));
  f.editor.retry(); expect(f.send).toHaveBeenCalledTimes(1);
  await f.editor.refresh(); expect(f.refresh).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.editor.getSnapshot().attempt).toBeNull();
});
it("keeps an unsent names draft when saving a different feature", async () => {
  const f = fixture(); await f.editor.load();
  const next = { ...f.editor.getSnapshot().draft, custom: { ...f.editor.getSnapshot().draft.custom, label: "Still typing" } };
  f.editor.edit(next); f.editor.submit({ kind: "module", module: "chat", enabled: false });
  f.editor.edit({ ...next, custom: { ...next.custom, label: "Frozen" } });
  await vi.waitFor(() => expect(f.editor.getSnapshot().attempt).toBeNull());
  expect(f.editor.getSnapshot().draft.custom.label).toBe("Still typing");
});
it.each(["userId", "orgId", "requestId"] as const)("does not accept an acknowledgement for another %s", async field => {
  const f = fixture(); await f.editor.load();
  f.send.mockImplementationOnce(async command => ({ ...scope, requestId: command.requestId, outcome: "applied", snapshot, [field]: field === "requestId" ? crypto.randomUUID() : "other" }));
  f.editor.submit({ kind: "module", module: "chat", enabled: false });
  await vi.waitFor(() => expect(f.editor.getSnapshot().attempt?.kind).toBe("unknown"));
  expect(f.refresh).not.toHaveBeenCalled();
});
it("keeps conflicting input until the operator explicitly uses current settings", async () => {
  const f = fixture(); await f.editor.load();
  const next = { ...f.editor.getSnapshot().draft, custom: { ...f.editor.getSnapshot().draft.custom, label: "Original draft" } };
  f.editor.edit(next);
  f.send.mockImplementationOnce(async command => ({ ...scope, requestId: command.requestId, outcome: "conflict", snapshot }));
  f.editor.submit({ kind: "custom", custom: next.custom });
  await vi.waitFor(() => expect(f.editor.getSnapshot().attempt).toMatchObject({ kind: "confirmed", refresh: "done" }));
  expect(f.editor.getSnapshot().draft.custom.label).toBe("Original draft");
  f.editor.submit({ kind: "module", module: "chat", enabled: false }); expect(f.send).toHaveBeenCalledTimes(1);
  f.editor.useCurrent(); expect(f.editor.getSnapshot().draft.custom.label).toBe("");
});
