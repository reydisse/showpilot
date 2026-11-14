export const ROLE_COLOURS: Record<string, string> = {
  owner: "#dc2626",
  admin: "#b45309",
  pm: "#2563eb",
  tm: "#047857",
  sm: "#7c3aed",
  member: "#4b5563",
};

export function getAccountInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
}
