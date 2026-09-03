import { describe, expect, it } from "vitest";
import { buildChatThreads, type ThreadableChatMessage } from "@showpilot/shared";

type Message = ThreadableChatMessage & { text: string };

describe("buildChatThreads", () => {
  it("keeps nested replies in a flat root thread", () => {
    const messages: Message[] = [
      { id: "root", timestamp: 1, text: "Root" },
      { id: "reply", timestamp: 2, text: "Reply", threadRootId: "root", replyTo: { messageId: "root" } },
      { id: "nested", timestamp: 3, text: "Nested", threadRootId: "root", replyTo: { messageId: "reply" } },
      { id: "other", timestamp: 4, text: "Other" },
    ];

    const threads = buildChatThreads(messages);

    expect(threads.map((thread) => thread.root.id)).toEqual(["root", "other"]);
    expect(threads[0]?.replies.map((message) => message.id)).toEqual(["reply", "nested"]);
    expect(threads[0]?.latestReply?.id).toBe("nested");
  });

  it("reconstructs legacy threads and keeps orphaned replies visible", () => {
    const messages: Message[] = [
      { id: "legacy-root", timestamp: 1, text: "Root" },
      { id: "legacy-reply", timestamp: 2, text: "Reply", replyTo: { messageId: "legacy-root" } },
      { id: "legacy-nested", timestamp: 3, text: "Nested", replyTo: { messageId: "legacy-reply" } },
      { id: "orphan", timestamp: 4, text: "Orphan", replyTo: { messageId: "not-loaded" } },
    ];

    const threads = buildChatThreads(messages);

    expect(threads[0]?.replies.map((message) => message.id)).toEqual(["legacy-reply", "legacy-nested"]);
    expect(threads[1]?.root.id).toBe("orphan");
  });
});
