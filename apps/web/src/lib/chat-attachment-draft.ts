import { ChatAttachmentDraft } from "@showpilot/shared/chat-attachment-draft";
import { CHAT_ATTACHMENT_MAX_BYTES, chatAttachmentName } from "@showpilot/shared/chat-attachment";
import { createBrowserRequestId } from "./browser-id";

export type WebChatAttachmentDraft = ChatAttachmentDraft<File, File>;
type Scope = { orgId: string; roomId: string; currentUserId?: string; guestToken?: string };
const drafts = new Map<string, WebChatAttachmentDraft>();

export function getChatAttachmentDraft(scope: Scope): WebChatAttachmentDraft | undefined {
  if (!scope.orgId || (!scope.currentUserId && !scope.guestToken)) return undefined;
  const key = JSON.stringify([scope.orgId, scope.roomId, scope.currentUserId, scope.guestToken]);
  const existing = drafts.get(key);
  if (existing) return existing;
  const params = () => {
    const value = new URLSearchParams({ room: scope.roomId });
    if (scope.guestToken) value.set("guestToken", scope.guestToken);
    else if (scope.currentUserId) value.set("expectedUserId", scope.currentUserId);
    return value;
  };
  const draft = new ChatAttachmentDraft<File, File>({
    orgId: scope.orgId, capacity: 6, newId: createBrowserRequestId,
    async prepare(source, id, signal) {
      if (!source.size || source.size > CHAT_ATTACHMENT_MAX_BYTES) throw new Error("Choose a non-empty file of 15 MB or less.");
      const bytes = await source.arrayBuffer();
      if (signal.aborted) throw new Error("Attachment preparation cancelled");
      const checksum = crypto.subtle
        ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
        : (await import("@noble/hashes/sha2.js")).sha256(new Uint8Array(bytes));
      const name = chatAttachmentName(source.name);
      const mimeType = source.type || "application/octet-stream";
      return { spec: { uploadId: id, name, mimeType, size: source.size,
        sha256: [...new Uint8Array(checksum)].map(value => value.toString(16).padStart(2, "0")).join("") },
        body: new File([bytes], name, { type: mimeType }) };
    },
    async upload(prepared, signal) {
      const query = params(); query.set("uploadId", prepared.spec.uploadId); query.set("sha256", prepared.spec.sha256); query.set("name", prepared.spec.name);
      const form = new FormData(); form.set("file", prepared.body);
      const response = await fetch(`/api/chat/${encodeURIComponent(scope.orgId)}/upload?${query}`, { method: "POST", body: form, signal });
      if (!response.ok) throw new Error(await response.text() || "Upload was not confirmed. Retry this file.");
      return response.json();
    },
    async cancel(spec, signal) {
      const response = await fetch(`/api/chat/${encodeURIComponent(scope.orgId)}/cancel-upload?${params()}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec), signal,
      });
      if (!response.ok) throw new Error(await response.text() || "Removal was not confirmed. Retry removing this attachment.");
    },
  });
  drafts.set(key, draft);
  return draft;
}
