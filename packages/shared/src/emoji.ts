export const QUICK_REACTION_EMOJIS = [
  "👍", "👎", "❤️", "🔥", "🎉", "😂", "😮", "😢", "🙏", "👏",
  "🙌", "💯", "✅", "❌", "⚠️", "👀", "🤔", "💡", "🚀", "🎬",
  "🎥", "🎤", "🎧", "🔊", "🔇", "⏱️", "📌", "🛠️", "🫡", "🤝",
] as const;

export type EmojiReaction = string;

const emojiCodePoint = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\uFE0F\u200D\u20E3#*0-9])$/u;
const visibleEmoji = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20E3)/u;

/** Accepts one or more emoji graphemes while rejecting text, whitespace, and controls. */
export function isEmojiReaction(value: unknown): value is EmojiReaction {
  if (typeof value !== "string" || value.length === 0 || value.length > 32 || value.trim() !== value) return false;
  if (!visibleEmoji.test(value)) return false;
  return [...value].every((character) => emojiCodePoint.test(character));
}
