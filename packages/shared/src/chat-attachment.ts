import { z } from "zod";

export const CHAT_ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
export function chatAttachmentName(name: string): string {
  const clean = name.replace(/[\\/\u0000-\u001f]/g, "-").trim().slice(0, 180);
  return !clean || clean === "." || clean === ".." ? "attachment" : clean;
}

export const chatUploadSpecSchema = z.object({
  uploadId: z.uuid(),
  name: z.string().min(1).max(180).refine(name => name === chatAttachmentName(name)),
  mimeType: z.string().min(1).max(180),
  size: z.number().int().positive().max(CHAT_ATTACHMENT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ChatUploadSpec = z.infer<typeof chatUploadSpecSchema>;

export const chatAttachmentSchema = z.object({
  id: z.string().min(1).max(100), name: z.string().min(1).max(180),
  url: z.string().startsWith("/api/chat-file/"),
  mimeType: z.string().min(1).max(180), size: z.number().int().nonnegative().max(CHAT_ATTACHMENT_MAX_BYTES),
}).strict();
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;

export function chatUploadAttachment(orgId: string, spec: ChatUploadSpec): ChatAttachment {
  return { id: spec.uploadId, name: spec.name, mimeType: spec.mimeType, size: spec.size,
    url: `/api/chat-file/${encodeURIComponent(orgId)}/${spec.uploadId}/${encodeURIComponent(spec.name)}` };
}
