export const RUNDOWN_SHORTCUTS = [
  { keys: "Shift + Space", label: "Play / pause" },
  { keys: "Shift + N", label: "Next item" },
  { keys: "Shift + P", label: "Previous item" },
  { keys: "S", label: "End show (confirmation required)" },
  { keys: "+", label: "Add 1 minute" },
  { keys: "−", label: "Subtract 1 minute" },
] as const;

export type RundownShortcut = "toggle-playback" | "next" | "previous" | "end-show" | "add-minute" | "subtract-minute";

/** Global shortcuts never consume typing, browser shortcuts, or modal input. */
export function rundownShortcut(event: KeyboardEvent): RundownShortcut | null {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return null;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.isContentEditable || target.closest('input, textarea, select, button, a, [role="button"], [contenteditable="true"]')) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    if (event.code === "Space" || key === " ") return "toggle-playback";
    if (event.code === "KeyN" || key === "n") return "next";
    if (event.code === "KeyP" || key === "p") return "previous";
  }
  if (key === "s") return "end-show";
  if (key === "+" || key === "=") return "add-minute";
  if (key === "-" || key === "_") return "subtract-minute";
  return null;
}
