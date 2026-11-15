/** Keep transport and storage details out of operator-facing failure copy. */
export function plainFailure(message: string, fallback = "This action needs attention."): string {
  const text = message.trim();
  const boundary = text.search(/[.!?](?:\s|$)/);
  const first = boundary < 0 ? text : text.slice(0, boundary + 1);
  if (/\bunauthorized\b/i.test(first)) return "Please sign in again.";
  if (/\bforbidden\b/i.test(first)) return "You do not have access to this action.";
  if (!first || first.length > 180 || /unconfirmed|confirm(?:ed|ation|ing)?|sync(?:ing|hron)|reconnect|poll(?:ing|ed)|check(?:ing|ed)|revision|relay|journal|acknowledg|deadline|timed? ?out|timeout|\b(?:API|IPC|JSON|fetch|engine|encryption|socket|transport)\b/i.test(message)) return fallback;
  return /[.!?]$/.test(first) ? first : `${first}.`;
}
