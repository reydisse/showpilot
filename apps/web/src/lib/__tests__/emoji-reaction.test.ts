import { describe, expect, it } from "vitest";
import { isEmojiReaction } from "@showpilot/shared";
import { parseChatMessage } from "../../../../mobile/src/lib/chat-history";

describe("emoji reaction contract", () => {
  it.each(["👍", "👍🏽", "🥳", "❤️", "👨‍👩‍👧‍👦", "🇨🇦", "1️⃣"])(
    "accepts and preserves %s",
    (emoji) => {
      expect(isEmojiReaction(emoji)).toBe(true);
      expect(parseChatMessage({
        id: "message-1",
        senderName: "Crew member",
        text: "Ready",
        type: "text",
        timestamp: 1,
        reactions: [{ emoji, userIds: ["user-1"] }],
      })?.reactions).toEqual([{ emoji, userIds: ["user-1"] }]);
    },
  );

  it.each(["", "hello", "👍 hello", " 👍", "👍 ", "!", "123"])(
    "rejects non-reaction text %j",
    (value) => expect(isEmojiReaction(value)).toBe(false),
  );
});
