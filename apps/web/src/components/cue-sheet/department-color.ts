import type { CSSProperties } from "react";

/** Stored colour ids stay compatible with every existing department. */
export const DEPARTMENT_COLORS = ["red", "amber", "green", "blue", "purple", "cyan"] as const;
export function departmentColor(color: string): string {
  if (DEPARTMENT_COLORS.some(value => value === color)) return `var(--color-dept-${color})`;
  return color === "pink" ? "var(--color-dept-red)" : "var(--board-muted)";
}
export function departmentStyle(color: string): CSSProperties {
  return { "--cue-dept": departmentColor(color) } as CSSProperties;
}
