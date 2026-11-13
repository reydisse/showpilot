import { ChatComposer } from "@showpilot/shared/chat-composer";
import type { ChatMessage } from "./adapters/chat-adapter";
export type WebChatComposer = ChatComposer<ChatMessage>;
const drafts = new Map<string, WebChatComposer>();
export function getChatComposer(scope: { orgId: string; roomId: string; currentUserId?: string; guestToken?: string; guestName?: string }): WebChatComposer {
  // Never retain request data in a server-wide registry, or share an anonymous draft.
  if (typeof window === "undefined" || !scope.orgId || (!scope.currentUserId && !scope.guestToken)) return new ChatComposer();
  const key = JSON.stringify([scope.orgId, scope.roomId, scope.guestToken ? ["guest", scope.guestToken, scope.guestName] : ["member", scope.currentUserId]]);
  let draft = drafts.get(key);
  if (!draft) { draft = new ChatComposer(); drafts.set(key, draft); }
  return draft;
}
