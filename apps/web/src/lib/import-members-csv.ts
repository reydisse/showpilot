// Pure CSV-import helpers — no Workers imports so they stay unit-testable
// (same split as kiosk.ts / kiosk-token.ts).

/** Minimal CSV parser: quoted fields, escaped quotes, CRLF/LF rows. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export interface ColumnMap {
  name?: number;
  firstName?: number;
  lastName?: number;
  email?: number;
  role?: number;
}

/**
 * Map headers to columns. Tolerates Planning Center export headers
 * ("First Name" + "Last Name" instead of "name", "Email Address").
 */
export function mapColumns(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  header.forEach((raw, i) => {
    const h = raw.trim().toLowerCase();
    if (h === "name" || h === "full name") map.name = i;
    else if (h === "first name" || h === "firstname") map.firstName = i;
    else if (h === "last name" || h === "lastname") map.lastName = i;
    else if (h === "email" || h === "email address" || h === "home email") map.email = i;
    else if (h === "role" || h === "position" || h === "team position") map.role = i;
  });
  return map;
}

/** Generate a badge-style member ID (initials + 4 digits) unique within `taken`. */
export function generateMemberId(name: string, taken: Set<string>): string {
  const words = name.trim().split(/\s+/);
  const initials = ((words[0]?.[0] ?? "X") + (words[1]?.[0] ?? words[0]?.[1] ?? "X"))
    .toUpperCase()
    .replace(/[^A-Z]/g, "X");
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `${initials}${Math.floor(1000 + Math.random() * 9000)}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
  // Practically unreachable; fall back to a longer random suffix.
  const id = `${initials}${Math.floor(100000 + Math.random() * 900000)}`;
  taken.add(id);
  return id;
}
