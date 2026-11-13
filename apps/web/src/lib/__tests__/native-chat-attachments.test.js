import * as React from "react";
import { File as TestFile } from "node:buffer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { chatUploadAttachment } from "@showpilot/shared/chat-attachment";
import { loadNativeAttachmentHook } from "../../test/native-chat-attachments-hook.js";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const scope = { user: "operator", org: "org", room: "production" };
function setup() {
  const upload = vi.fn(async input => chatUploadAttachment(input.orgId, input.spec));
  const cancel = vi.fn(async () => {});
  const manipulate = vi.fn(async () => ({ uri: "converted.jpg" }));
  class File extends TestFile {
    constructor(uri) { super(["notes"], uri, { type: uri.endsWith("jpg") ? "image/jpeg" : "text/plain" }); this.exists = true; }
  }
  const hook = loadNativeAttachmentHook({ File, manipulate, upload, cancel });
  const client = new QueryClient(); const wrapper = ({ children }) => React.createElement(QueryClientProvider, { client }, children);
  const mount = (initialProps = scope) => renderHook(p => hook(p.user, p.org, p.room), { initialProps, wrapper });
  return { ...mount(), mount, client, upload, cancel, manipulate };
}
it.each(["user", "org", "room"])("keeps attachment recovery in its original %s scope", async field => {
  const f = setup(); f.upload.mockRejectedValueOnce(new Error("Reply lost"));
  let id;
  act(() => { id = f.result.current.draft.add({ uri: "notes.txt", name: "notes.txt" }, "notes.txt"); });
  await waitFor(() => expect(f.result.current.work[0].state).toBe("upload-failed"));
  f.rerender({ ...scope, [field]: "other" }); expect(f.result.current.work).toEqual([]);
  f.rerender(scope); expect(f.result.current.work[0]).toMatchObject({ id, state: "upload-failed" });
  act(() => f.result.current.draft.retry(id));
  await waitFor(() => expect(f.result.current.work[0].state).toBe("ready"));
  expect(f.upload.mock.calls[1][0]).toMatchObject({ userId: "operator", orgId: "org", roomId: "production", spec: { uploadId: id } });
  expect(f.upload.mock.calls[0][0].spec).toEqual(f.upload.mock.calls[1][0].spec);
  f.unmount(); const next = f.mount(); expect(next.result.current.ready).toHaveLength(1);
});
it("retains failed server removal and retries it without resending the upload", async () => {
  const f = setup(); let id;
  act(() => { id = f.result.current.draft.add({ uri: "notes.txt" }, "notes.txt"); });
  await waitFor(() => expect(f.result.current.ready).toHaveLength(1));
  f.cancel.mockRejectedValueOnce(new Error("Storage unavailable"));
  act(() => f.result.current.draft.remove(id));
  await waitFor(() => expect(f.result.current.work[0]).toMatchObject({ state: "remove-failed", error: "Storage unavailable" }));
  expect(f.result.current.blocked).toBe(true);
  act(() => f.result.current.draft.retry(id));
  await waitFor(() => expect(f.result.current.work).toEqual([]));
  expect(f.upload).toHaveBeenCalledTimes(1);
  expect(f.cancel.mock.calls[0][0]).toEqual(f.cancel.mock.calls[1][0]);
});
it("never uploads a HEIC conversion that finishes after its deadline", async () => {
  vi.useFakeTimers(); const f = setup(); let finish = () => {};
  f.manipulate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  act(() => f.result.current.draft.add({ uri: "photo.heic", name: "photo.heic", mimeType: "image/heic", image: true }, "photo.heic"));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(f.result.current.work[0].state).toBe("upload-failed");
  await act(async () => finish({ uri: "converted.jpg" }));
  expect(f.upload).not.toHaveBeenCalled();
});
it("normalizes HEIC once and retries the same JPEG with its original checksum", async () => {
  const f = setup(); f.upload.mockRejectedValueOnce(new Error("Reply lost")); let id;
  act(() => { id = f.result.current.draft.add({ uri: "photo.heic", name: "photo.heic", mimeType: "image/heic", image: true }, "photo.heic"); });
  await waitFor(() => expect(f.result.current.work[0].state).toBe("upload-failed"));
  act(() => f.result.current.draft.retry(id));
  await waitFor(() => expect(f.result.current.ready).toHaveLength(1));
  expect(f.manipulate).toHaveBeenCalledTimes(1);
  expect(f.upload.mock.calls[0][0].spec).toMatchObject({ uploadId: id, name: "photo.jpg", mimeType: "image/jpeg", size: 5 });
  expect(f.upload.mock.calls[0][0].spec).toEqual(f.upload.mock.calls[1][0].spec);
});
