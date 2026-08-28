const BLOCKED_CONTENT = [
  /\b(?:kill|hurt|attack|shoot)\s+(?:you|them|him|her)\b/i,
  /\b(?:child\s*(?:porn|sexual)|sexual\s*(?:content|image)\s+of\s+a\s+minor)\b/i,
  /\b(?:send|share|post)\s+(?:nudes?|pornographic\s+(?:photos?|videos?))\b/i,
];

export function objectionableContentReason(value: string): string | null {
  const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (BLOCKED_CONTENT.some((pattern) => pattern.test(text))) {
    return "This content may contain a threat or prohibited sexual material.";
  }
  if ((text.match(/https?:\/\//gi)?.length ?? 0) > 5) {
    return "Messages may contain no more than five links.";
  }
  return null;
}
