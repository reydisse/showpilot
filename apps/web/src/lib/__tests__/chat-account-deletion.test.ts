import { describe, expect, it } from "vitest";
import { scrubDeletedUserFromChat, type DeletableChatMessage } from "@/lib/chat-account-deletion";

interface TestMessage extends DeletableChatMessage {
  text: string;
}

describe("native chat account deletion", () => {
  it("removes authored messages and all references to the deleted user", () => {
    const messages: TestMessage[] = [
      { id: "authored", orgId: "org-1", senderId: "leaving", text: "private", attachments: [{ url: "/file" }] },
      {
        id: "remaining",
        orgId: "org-1",
        senderId: "remaining-user",
        text: "reply",
        replyTo: { messageId: "authored", senderName: "Leaving User", text: "private" },
        reactions: [
          { emoji: "👍", userIds: ["leaving", "remaining-user"] },
          { emoji: "❤️", userIds: ["leaving"] },
        ],
        poll: { question: "Ready?", options: [{ id: "yes", text: "Yes", voterIds: ["leaving", "remaining-user"] }] },
      },
    ];

    const result = scrubDeletedUserFromChat(messages, "leaving");

    expect(result.deleted.map((message) => message.id)).toEqual(["authored"]);
    expect(result.messages).toEqual([{
      id: "remaining",
      orgId: "org-1",
      senderId: "remaining-user",
      text: "reply",
      replyTo: { messageId: "authored", senderName: "Deleted user", text: "Message deleted" },
      reactions: [{ emoji: "👍", userIds: ["remaining-user"] }],
      poll: { question: "Ready?", options: [{ id: "yes", text: "Yes", voterIds: ["remaining-user"] }] },
    }]);
  });

  it("does not mutate its input", () => {
    const messages: TestMessage[] = [{ id: "one", orgId: "org-1", senderId: "other", text: "hello", reactions: [{ emoji: "👍", userIds: ["leaving"] }] }];
    const before = structuredClone(messages);
    scrubDeletedUserFromChat(messages, "leaving");
    expect(messages).toEqual(before);
  });
});
