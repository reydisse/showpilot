import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatUploadSpec } from "@showpilot/shared/chat-attachment";
import { cancelChatUpload, reserveChatUpload, chatFileIsDeleted, chatUploadClaimKey, chatUploadFileKey, eraseChatAttachment, storeChatAttachment } from "../chat-attachment-storage.server";

afterEach(() => vi.restoreAllMocks());

async function fixture(text = "Stage notes") {
  const body = new TextEncoder().encode(text).buffer;
  const digest = await crypto.subtle.digest("SHA-256", body);
  const spec: ChatUploadSpec = { uploadId: crypto.randomUUID(), name: "notes.txt", mimeType: "text/plain", size: body.byteLength,
    sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
  const owner = { orgId: crypto.randomUUID(), roomId: "production", ownerId: "operator" };
  return { owner, spec, body, key: chatUploadFileKey(owner.orgId, spec) };
}

describe("chat attachment storage identities", () => {
  it("recovers one file after a lost reply and concurrent retries", async () => {
    const f = await fixture();
    const replies = await Promise.all(Array.from({ length: 3 }, () => storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body)));
    expect(replies[1]).toEqual(replies[0]); expect(replies[2]).toEqual(replies[0]);
    const first = await env.STORAGE.head(f.key);
    expect(first).not.toBeNull();
    expect(await storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body)).toEqual(replies[0]);
    expect((await env.STORAGE.head(f.key))?.version).toBe(first?.version);
    expect((await env.STORAGE.list({ prefix: `orgs/${f.owner.orgId}/chat/` })).objects.map(object => object.key).sort()).toEqual([chatUploadClaimKey(f.owner.orgId, f.spec.uploadId), f.key].sort());
  });

  it.each(["name", "roomId", "ownerId", "sha256"] as const)("refuses changed %s on an existing upload identity", async field => {
    const f = await fixture(); await storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body);
    const owner = { ...f.owner }, spec = { ...f.spec };
    if (field === "roomId" || field === "ownerId") owner[field] = "other";
    else spec[field] = field === "name" ? "different.txt" : "f".repeat(64);
    await expect(storeChatAttachment(env.STORAGE, owner, spec, f.body)).rejects.toThrow("different file, account or conversation");
    expect(await (await env.STORAGE.get(f.key))?.text()).toBe("Stage notes");
  });

  it("has R2 reject bytes that do not match the declared checksum", async () => {
    const f = await fixture();
    await expect(storeChatAttachment(env.STORAGE, f.owner, f.spec, new TextEncoder().encode("Other notes").buffer)).rejects.toThrow();
    expect(await env.STORAGE.head(f.key)).toBeNull();
    await expect(storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body)).resolves.toMatchObject({ id: f.spec.uploadId });
  });

  it("erases file content without allowing an old upload to recreate it", async () => {
    const f = await fixture(); await storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body);
    const original = await env.STORAGE.head(f.key); if (!original) throw new Error("Missing fixture upload");
    await eraseChatAttachment(env.STORAGE, original);
    const tombstone = await env.STORAGE.head(f.key); if (!tombstone) throw new Error("Missing deletion marker");
    expect(chatFileIsDeleted(tombstone)).toBe(true); expect(tombstone.size).toBe(0);
    await eraseChatAttachment(env.STORAGE, original);
    await expect(storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body)).rejects.toThrow("attachment was removed");
    expect((await env.STORAGE.head(f.key))?.size).toBe(0);
  });
  it("cancels before the original request arrives and keeps retries cancelled", async () => {
    const f = await fixture();
    await reserveChatUpload(env.STORAGE, f.owner, f.spec);
    await cancelChatUpload(env.STORAGE, f.owner, f.spec);
    await cancelChatUpload(env.STORAGE, f.owner, f.spec);
    await expect(storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body)).rejects.toThrow("attachment was removed");
    expect(await (await env.STORAGE.get(f.key))?.text()).toBe("");
  });

  it("cancels a delayed file write without letting it restore the bytes", async () => {
    const f = await fixture();
    let release = () => {}, entered = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const put = env.STORAGE.put.bind(env.STORAGE);
    vi.spyOn(env.STORAGE, "put").mockImplementation(async (key, value, options) => {
      if (key === f.key && value !== null) { entered(); await held; }
      return put(key, value, options);
    });
    const uploading = storeChatAttachment(env.STORAGE, f.owner, f.spec, f.body);
    const result = expect(uploading).rejects.toThrow("attachment was removed");
    try {
      await started;
      await reserveChatUpload(env.STORAGE, f.owner, f.spec);
      await cancelChatUpload(env.STORAGE, f.owner, f.spec);
    } finally { release(); }
    await result;
    const object = await env.STORAGE.get(f.key);
    expect(object && chatFileIsDeleted(object)).toBe(true);
    expect(await object?.text()).toBe("");
  });

});
