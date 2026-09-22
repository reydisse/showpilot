const FORMULA_PREFIX = /^[\u0000-\u0020]*[=+\-@]/;

/** Make user-authored CSV text literal when opened in a spreadsheet. */
export function spreadsheetSafeText(value: unknown): string {
  const text = value == null ? "" : String(value);
  return FORMULA_PREFIX.test(text) ? `'${text}` : text;
}

export function spreadsheetSafeCsvCell(value: unknown): string {
  const text = spreadsheetSafeText(value);
  return `"${text.replace(/"/g, '""')}"`;
}
