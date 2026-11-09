type RosterPosition = { department: string; role: string };

/** Older/imported assignments may not have a department. Use the same label
 * for the department picker and row grouping so those positions remain visible. */
export function rosterDepartment(position: RosterPosition): string {
  if (position.department.trim()) return position.department.trim();
  const role = position.role.toLowerCase();
  if (/audio|sound|foh|monitor|wireless|mic/.test(role)) return "Audio";
  if (/camera|video|graphics|stream|projection|playback/.test(role)) return "Video";
  if (/worship|vocal|guitar|bass|drum|keys|music/.test(role)) return "Worship";
  return "Production";
}

export function groupRosterRows<T extends RosterPosition>(rows: T[], departments: string[]) {
  const groups = new Map<string, T[]>();
  for (const department of departments) {
    const name = department.trim();
    if (name && !groups.has(name)) groups.set(name, []);
  }
  for (const row of rows) {
    const name = rosterDepartment(row);
    const group = groups.get(name);
    if (group) group.push(row);
    else groups.set(name, [row]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => ({ name, rows }));
}
