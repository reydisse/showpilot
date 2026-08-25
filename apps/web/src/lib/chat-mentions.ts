export interface MentionCandidate {
  userId: string;
  name: string;
}

const trailingMentionPattern = /(?:^|\s)@([^\n@]*)$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function includesMention(text: string, name: string): boolean {
  const escapedName = escapeRegExp(name);
  return new RegExp(`(^|\\s)@${escapedName}(?=\\s|$|[.,!?;:])`, "i").test(text);
}

export function mentionedUserIds(text: string, members: readonly MentionCandidate[]): string[] {
  return members.filter((member) => includesMention(text, member.name)).map((member) => member.userId);
}

export function mentionSearch(text: string): string | null {
  return text.match(trailingMentionPattern)?.[1]?.toLowerCase() ?? null;
}

export function insertMention(text: string, name: string): string {
  return text.replace(trailingMentionPattern, (match) => `${match.startsWith(" ") ? " " : ""}@${name} `);
}
