import { useMemo, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";
import { File } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import * as ImageManipulator from "expo-image-manipulator";
import { sha256 } from "@noble/hashes/sha2.js";
import { ChatAttachmentDraft, type ChatAttachmentWork } from "@showpilot/shared/chat-attachment-draft";
import { chatAttachmentName, CHAT_ATTACHMENT_MAX_BYTES } from "@showpilot/shared/chat-attachment";
import { uploadMobileChatAttachment, cancelMobileChatUpload } from "../lib/mobile-api";
import { createLocalRequestUuid } from "../lib/request-id";

export type MobileAttachmentSource = { uri: string; name?: string | null; image?: boolean; mimeType?: string | null };
export type MobileAttachmentDraft = ChatAttachmentDraft<MobileAttachmentSource, Blob>;
const drafts = new WeakMap<QueryClient, Map<string, MobileAttachmentDraft>>();
const empty: ChatAttachmentWork[] = [];
const emptySnapshot = () => empty;
const noSubscription = () => () => {};

function getDraft(client: QueryClient, userId: string, orgId: string, roomId: string): MobileAttachmentDraft {
  let rooms = drafts.get(client);
  if (!rooms) { rooms = new Map(); drafts.set(client, rooms); }
  const key = JSON.stringify([userId, orgId, roomId]);
  const existing = rooms.get(key); if (existing) return existing;
  const draft = new ChatAttachmentDraft<MobileAttachmentSource, Blob>({
    orgId, capacity: 1, newId: createLocalRequestUuid,
    async prepare(source, id, signal) {
      let uri = source.uri, name = source.name;
      if (source.image && (/image\/hei[cf]/i.test(source.mimeType ?? "") || /\.hei[cf]$/i.test(name ?? uri))) {
        const converted = await ImageManipulator.manipulateAsync(uri, [], { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
        if (signal.aborted) throw new Error("Attachment preparation cancelled");
        uri = converted.uri; name = `${(name ?? "photo").replace(/\.[^.]+$/, "")}.jpg`;
      }
      let file: Blob;
      if (Platform.OS === "web") {
        const response = await expoFetch(uri, { signal });
        if (!response.ok) throw new Error("The selected attachment could not be opened. Choose it again.");
        file = await response.blob();
      } else {
        const local = new File(uri);
        if (!local.exists) throw new Error("The selected attachment is no longer available. Choose it again.");
        name ??= local.name;
        file = local;
      }
      if (!file.size || file.size > CHAT_ATTACHMENT_MAX_BYTES) throw new Error("Choose a non-empty attachment of 15 MB or less.");
      if (!file.type) throw new Error("The attachment's file type could not be read. Choose another copy of the file.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (signal.aborted) throw new Error("Attachment preparation cancelled");
      return { body: file, spec: { uploadId: id, name: chatAttachmentName(name ?? "attachment"), size: file.size, mimeType: file.type,
        sha256: [...sha256(bytes)].map(value => value.toString(16).padStart(2, "0")).join("") } };
    },
    upload: (prepared, signal) => uploadMobileChatAttachment({ orgId, roomId, userId, ...prepared }, signal),
    cancel: (spec, signal) => cancelMobileChatUpload({ orgId, roomId, userId, spec }, signal),
  });
  rooms.set(key, draft); return draft;
}

export function useChatAttachments(userId: string | undefined, orgId: string | undefined, roomId: string) {
  const client = useQueryClient();
  const draft = useMemo(() => userId && orgId ? getDraft(client, userId, orgId, roomId) : undefined, [client, userId, orgId, roomId]);
  const work = useSyncExternalStore(draft?.subscribe ?? noSubscription, draft?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return { draft, work, blocked: work.some(item => item.state !== "ready"),
    ready: work.flatMap(item => item.state === "ready" ? [item.attachment] : []) };
}
