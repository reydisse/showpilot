// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getChatAttachmentDraft } from "../chat-attachment-draft";

afterEach(() => vi.unstubAllGlobals());

describe("web attachment scope and transfer", () => {
  it("retains each conversation's draft separately for the original account", () => {
    const scope = { orgId: crypto.randomUUID(), roomId: "production", currentUserId: "operator" };
    const first = getChatAttachmentDraft(scope);
    expect(getChatAttachmentDraft({ ...scope })).toBe(first);
    expect(getChatAttachmentDraft({ ...scope, currentUserId: "other" })).not.toBe(first);
    expect(getChatAttachmentDraft({ ...scope, roomId: "planning" })).not.toBe(first);
    expect(getChatAttachmentDraft({ ...scope, orgId: "other" })).not.toBe(first);
    expect(getChatAttachmentDraft({ orgId: scope.orgId, roomId: "production" })).toBeUndefined();
  });

  it("sends stable file bytes, checksum and original actor through recovery and removal", async () => {
    const orgId = crypto.randomUUID();
    const requests: { path: URL; init: RequestInit }[] = [];
    let uploads = 0;
    vi.stubGlobal("fetch", vi.fn(async (target: string, init: RequestInit) => {
      const path = new URL(target, "https://app.test"); requests.push({ path, init });
      if (path.pathname.endsWith("cancel-upload")) return new Response(null, { status: 204 });
      if (!(init.body instanceof FormData)) throw new Error("Expected multipart data");
      const file = init.body.get("file"); if (!(file instanceof File)) throw new Error("Expected attachment bytes");
      expect(await file.text()).toBe("notes"); expect(file.name).toBe("stage-notes.txt");
      expect(path.searchParams.get("sha256")).toBe(createHash("sha256").update("notes").digest("hex"));
      uploads++;
      if (uploads === 1) throw new Error("Upload reply lost");
      const id = path.searchParams.get("uploadId");
      return Response.json({ id, name: file.name, mimeType: file.type, size: file.size, url: `/api/chat-file/${orgId}/${id}/${file.name}` });
    }));
    const draft = getChatAttachmentDraft({ orgId, roomId: "planning", currentUserId: "original-account" });
    if (!draft) throw new Error("Missing draft");
    const id = draft.add(new File(["notes"], "stage/notes.txt", { type: "text/plain" }), "stage/notes.txt");
    await vi.waitFor(() => expect(draft.getSnapshot()[0].state).toBe("upload-failed"));
    draft.retry(id);
    await vi.waitFor(() => expect(draft.getSnapshot()[0].state).toBe("ready"));
    expect(requests[0].path.href).toBe(requests[1].path.href);
    draft.remove(id);
    await vi.waitFor(() => expect(draft.getSnapshot()).toEqual([]));
    expect(requests).toHaveLength(3);
    for (const { path } of requests) {
      expect(path.searchParams.get("room")).toBe("planning");
      expect(path.searchParams.get("expectedUserId")).toBe("original-account");
    }
    expect(JSON.parse(String(requests[2].init.body))).toMatchObject({ uploadId: id, name: "stage-notes.txt", sha256: requests[0].path.searchParams.get("sha256") });
  });
});
