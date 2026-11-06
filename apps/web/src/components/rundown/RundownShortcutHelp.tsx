import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { RUNDOWN_SHORTCUTS } from "@/lib/rundown-shortcuts";

const DISMISSED_KEY = "showpilot:rundown-shortcuts:shift-v1";

export function RundownShortcutList() {
  return <dl className="space-y-2 text-xs text-board-muted">{RUNDOWN_SHORTCUTS.map(({ keys, label }) => (
    <div key={keys} className="flex flex-wrap items-center justify-between gap-2"><dt>{label}</dt><dd><kbd className="rounded border border-board-border bg-board-bg px-2 py-1 font-mono">{keys}</kbd></dd></div>
  ))}</dl>;
}

export function RundownShortcutBanner() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try { setVisible(localStorage.getItem(DISMISSED_KEY) !== "true"); }
    catch { setVisible(true); }
  }, []);
  if (!visible) return null;
  return <section aria-label="Rundown keyboard shortcuts" className="mx-4 my-3 max-h-[40dvh] shrink-0 overflow-y-auto rounded-xl border border-board-border bg-board-card p-4">
    <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-board-text">Keyboard shortcuts</h2><Button variant="ghost" type="button" className="min-h-11 rounded-lg px-3 text-sm text-board-muted" onClick={() => {
      setVisible(false);
      try { localStorage.setItem(DISMISSED_KEY, "true"); } catch { /* Dismiss still works without browser storage. */ }
    }}>Dismiss shortcuts</Button></div>
    <p className="mb-3 text-sm text-board-muted">Hold Shift to start or move between items. Space by itself does nothing.</p>
    <RundownShortcutList />
  </section>;
}
