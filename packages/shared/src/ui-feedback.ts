/** Keep transport and storage details out of operator-facing failure copy. */
export function plainFailure(message: string, fallback = "This action needs attention."): string {
  const text = message.trim();
  const boundary = text.search(/[.!?](?:\s|$)/);
  const first = boundary < 0 ? text : text.slice(0, boundary + 1);
  if (/\bunauthorized\b/i.test(first)) return "Please sign in again.";
  if (/\bforbidden\b/i.test(first)) return "You do not have access to this action.";
  if (!first || first.length > 180 || /unconfirmed|confirm(?:ed|ation|ing)?|sync(?:ing|hron)|reconnect|poll(?:ing|ed)|check(?:ing|ed)|revision|relay|journal|acknowledg|deadline|timed? ?out|timeout|\b(?:API|IPC|JSON|fetch|engine|encryption|socket|transport|WebSocket|D1_ERROR|SQLITE_\w+|PrismaClient\w*Error|TypeError|ReferenceError|SyntaxError|RangeError)\b|\bHTTP(?:\/[\d.]+)?[ _:]*[45]\d\d\b|Cannot (?:read|set) properties of|is not (?:a function|defined)/i.test(message)) return fallback;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}
