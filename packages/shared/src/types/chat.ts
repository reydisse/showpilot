export interface ThreadableChatMessage {
  id: string;
  timestamp: number;
  threadRootId?: string;
  replyTo?: { messageId: string };
}

export interface ChatThread<T extends ThreadableChatMessage> {
  root: T;
  replies: T[];
  latestReply?: T;
}

function compareMessages(left: ThreadableChatMessage, right: ThreadableChatMessage): number {
  return left.timestamp - right.timestamp || left.id.localeCompare(right.id);
}

/**
 * Builds a flat list of conversations from relay messages.
 *
 * New messages carry `threadRootId`. The parent walk preserves threads created
 * before that field existed. A missing root remains visible as its own root so
 * pagination can never make a message disappear.
 */
export function buildChatThreads<T extends ThreadableChatMessage>(messages: readonly T[]): ChatThread<T>[] {
  const ordered = [...messages].sort(compareMessages);
  const byId = new Map(ordered.map((message) => [message.id, message]));

  function resolveRoot(message: T): T {
    if (message.threadRootId && message.threadRootId !== message.id) {
      const explicitRoot = byId.get(message.threadRootId);
      if (explicitRoot) return explicitRoot;
    }

    let current = message;
    const visited = new Set([message.id]);
    while (current.replyTo?.messageId) {
      const parent = byId.get(current.replyTo.messageId);
      if (!parent || visited.has(parent.id)) break;
      current = parent;
      visited.add(parent.id);
    }
    return current === message && message.replyTo ? message : current;
  }

  const rootByMessageId = new Map(ordered.map((message) => [message.id, resolveRoot(message)]));
  const threadsByRootId = new Map<string, ChatThread<T>>();

  for (const message of ordered) {
    const root = rootByMessageId.get(message.id) ?? message;
    let thread = threadsByRootId.get(root.id);
    if (!thread) {
      thread = { root, replies: [] };
      threadsByRootId.set(root.id, thread);
    }
    if (message.id !== root.id) thread.replies.push(message);
  }

  return [...threadsByRootId.values()]
    .map((thread) => ({
      ...thread,
      ...(thread.replies.length ? { latestReply: thread.replies[thread.replies.length - 1] } : {}),
    }))
    .sort((left, right) => compareMessages(left.root, right.root));
}
