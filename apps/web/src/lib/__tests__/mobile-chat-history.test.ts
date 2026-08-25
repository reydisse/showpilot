import { describe, expect, it } from "vitest";
import {
  mergeChatMessage,
  parseChatHistoryPage,
  parseChatMessage,
  type MobileChatMessage,
} from "../../../../mobile/src/lib/chat-history";

function message(id: string, timestamp: number, text = id): MobileChatMessage {
  return {
    id,
    senderName: "Crew member",
    text,
    type: "text",
    timestamp,
  };
}

describe("mobile chat history", () => {
  it("keeps valid persisted messages and rejects invalid payloads", () => {
    expect(parseChatMessage(message("message-1", 100))).toEqual(message("message-1", 100));
    expect(parseChatMessage({ id: "message-2", timestamp: Number.NaN })).toBeNull();
    expect(parseChatMessage({ ...message("message-3", 300), type: "malware" })).toBeNull();
  });

  it("merges edits by ID without dropping older messages", () => {
    let messages: MobileChatMessage[] = [];
    for (let index = 0; index < 2_100; index += 1) {
      messages = mergeChatMessage(messages, message(`message-${index}`, index));
    }
    messages = mergeChatMessage(messages, message("message-0", 0, "edited"));

    expect(messages).toHaveLength(2_100);
    expect(messages[0].text).toBe("edited");
  });

  it("parses an older-history cursor and filters corrupt rows", () => {
    expect(parseChatHistoryPage({
      messages: [message("message-1", 100), { broken: true }],
      nextCursor: { timestamp: 100, id: "message-1" },
    })).toEqual({
      messages: [message("message-1", 100)],
      nextCursor: { timestamp: 100, id: "message-1" },
    });
  });
});
