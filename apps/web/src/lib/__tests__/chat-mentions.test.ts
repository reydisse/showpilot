import { describe, expect, it } from "vitest";
import { includesMention, insertMention, mentionedUserIds, mentionSearch } from "../chat-mentions";

const members = [
  { userId: "user-ama", name: "Ama Mensah" },
  { userId: "user-joe", name: "Joe O'Neil" },
] as const;

describe("chat mentions", () => {
  it("matches complete names regardless of case or trailing punctuation", () => {
    expect(includesMention("Please check this, @ama mensah!", "Ama Mensah")).toBe(true);
    expect(includesMention("Ask @Joe O'Neil.", "Joe O'Neil")).toBe(true);
    expect(includesMention("Ask @Ama", "Ama Mensah")).toBe(false);
    expect(includesMention("email@ama mensah", "Ama Mensah")).toBe(false);
  });

  it("returns only the members explicitly mentioned", () => {
    expect(mentionedUserIds("@Ama Mensah please call @Joe O'Neil", members)).toEqual(["user-ama", "user-joe"]);
    expect(mentionedUserIds("No mentions here", members)).toEqual([]);
  });

  it("derives and inserts the active trailing mention", () => {
    expect(mentionSearch("Hello @am")).toBe("am");
    expect(mentionSearch("Hello @Ama\nnext line")).toBeNull();
    expect(insertMention("Hello @am", "Ama Mensah")).toBe("Hello @Ama Mensah ");
    expect(insertMention("@jo", "Joe O'Neil")).toBe("@Joe O'Neil ");
  });
});
