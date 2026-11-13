import { chatUploadAttachment, type ChatUploadSpec } from "@showpilot/shared/chat-attachment";

export class ChatAttachmentStorageError extends Error {
  constructor(readonly status: 409 | 410 | 503, message: string) { super(message); }
}
export type ChatUploadOwner = { orgId: string; roomId: string; ownerId: string };
export const chatUploadClaimKey = (orgId: string, uploadId: string) => `orgs/${orgId}/chat/_uploads/${uploadId}`;
export const chatUploadFileKey = (orgId: string, spec: ChatUploadSpec) => `orgs/${orgId}/chat/${spec.uploadId}/${spec.name}`;
export const chatFileIsDeleted = (object: Pick<R2Object, "customMetadata">) => object.customMetadata?.kind === "chat-file-deleted";

/** The claim makes an upload ID immutable across names, rooms and actors. R2's
 * conditional create also prevents a delayed retry from replacing file bytes.
 * The checksum is checked by R2 against the body, not just copied as metadata. */
function uploadMetadata(owner: ChatUploadOwner, spec: ChatUploadSpec) {
  return { uploadedBy: owner.ownerId, roomId: owner.roomId,
    chatUpload: JSON.stringify([owner.orgId, owner.roomId, owner.ownerId, spec.uploadId, spec.name, spec.mimeType, spec.size, spec.sha256]) };
}

export async function reserveChatUpload(bucket: R2Bucket, owner: ChatUploadOwner, spec: ChatUploadSpec): Promise<void> {
  const metadata = uploadMetadata(owner, spec);
  const claimKey = chatUploadClaimKey(owner.orgId, spec.uploadId);
  const claim = await bucket.put(claimKey, null, { onlyIf: new Headers({ "If-None-Match": "*" }), customMetadata: { ...metadata, kind: "chat-upload-claim" } })
    ?? await bucket.head(claimKey);
  if (!claim) throw new ChatAttachmentStorageError(503, "The upload reservation was not confirmed. Recover this upload.");
  if (claim.customMetadata?.chatUpload !== metadata.chatUpload) throw new ChatAttachmentStorageError(409, "This upload ID belongs to a different file, account or conversation.");
}

export async function storeChatAttachment(bucket: R2Bucket, owner: ChatUploadOwner, spec: ChatUploadSpec, body: ReadableStream<Uint8Array> | ArrayBuffer) {
  await reserveChatUpload(bucket, owner, spec);
  const metadata = uploadMetadata(owner, spec);
  const key = chatUploadFileKey(owner.orgId, spec);
  const existing = await bucket.head(key);
  const stored = existing ?? await bucket.put(key, body, {
    onlyIf: new Headers({ "If-None-Match": "*" }), sha256: spec.sha256,
    httpMetadata: { contentType: spec.mimeType }, customMetadata: { ...metadata, kind: "chat-file" },
  }) ?? await bucket.head(key);
  if (!stored) throw new ChatAttachmentStorageError(503, "The upload was not confirmed. Recover this upload.");
  if (chatFileIsDeleted(stored)) throw new ChatAttachmentStorageError(410, "This attachment was removed. Choose the file again to create a new upload.");
  if (stored.customMetadata?.chatUpload !== metadata.chatUpload || stored.size !== spec.size) throw new ChatAttachmentStorageError(409, "The stored attachment does not match this upload.");
  return chatUploadAttachment(owner.orgId, spec);
}

/** Called after the room authority reserves deletion and checks live references.
 * Replace content with a zero-byte marker instead of reopening an absent key:
 * an upload already in flight cannot conditionally recreate a discarded file.
 * Account erasure removes both markers and upload claims via the chat prefix. */
export async function eraseChatAttachment(bucket: R2Bucket, object: R2Object): Promise<void> {
  if (chatFileIsDeleted(object)) return;
  const removed = await bucket.put(object.key, null, {
    onlyIf: { etagMatches: object.etag },
    customMetadata: { ...object.customMetadata, kind: "chat-file-deleted" },
  });
  if (removed) return;
  const current = await bucket.head(object.key);
  if (current && chatFileIsDeleted(current) && current.customMetadata?.uploadedBy === object.customMetadata?.uploadedBy) return;
  throw new ChatAttachmentStorageError(409, "The attachment changed during removal. Check the original attachment before retrying.");
}

/** The room must reserve the ID against message attachment first. Creating the
 * empty marker also cancels uploads that have not reached storage yet. A file
 * that wins the conditional create is erased before cancellation is confirmed. */
export async function cancelChatUpload(bucket: R2Bucket, owner: ChatUploadOwner, spec: ChatUploadSpec): Promise<void> {
  const key = chatUploadFileKey(owner.orgId, spec);
  const metadata = uploadMetadata(owner, spec);
  const marker = await bucket.put(key, null, {
    onlyIf: new Headers({ "If-None-Match": "*" }), customMetadata: { ...metadata, kind: "chat-file-deleted" },
  });
  if (marker) return;
  const object = await bucket.head(key);
  if (!object) throw new ChatAttachmentStorageError(503, "Attachment removal was not confirmed. Retry removing this attachment.");
  if (object.customMetadata?.chatUpload !== metadata.chatUpload) throw new ChatAttachmentStorageError(409, "This upload ID belongs to a different file, account or conversation.");
  await eraseChatAttachment(bucket, object);
}
