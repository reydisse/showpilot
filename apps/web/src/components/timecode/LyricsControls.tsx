import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LyricsOperation } from "@/lib/lyrics-control";

export function lyricsShortcut(event: KeyboardEvent): "next" | "previous" | null {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]')) return null;
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.isContentEditable || target.closest('input, textarea, select, button, a, [role="button"], [role="slider"], [role="textbox"], [role="menu"], [role="menuitem"], [role="option"], [role="tablist"], [role="tab"], [role="listbox"], [role="tree"], [role="combobox"], [role="spinbutton"], [contenteditable]:not([contenteditable="false"])')) return null;
  return event.key === "ArrowRight" ? "next" : event.key === "ArrowLeft" ? "previous" : null;
}

export function LyricsControls({ enabled, pending, error, onChange, keyboard = false }: {
  enabled: boolean;
  pending: LyricsOperation | null;
  error: string | null;
  onChange: (operation: LyricsOperation) => Promise<void>;
  keyboard?: boolean;
}) {
  useEffect(() => {
    if (!keyboard || !enabled || pending) return;
    const handle = (event: KeyboardEvent) => {
      const operation = lyricsShortcut(event);
      if (!operation) return;
      event.preventDefault();
      void onChange(operation).catch(() => { /* The command hook displays the error. */ });
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [keyboard, enabled, pending, onChange]);
  return <div className="space-y-2" data-lyrics-controls>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={!enabled || pending !== null} onClick={() => { void onChange("previous").catch(() => {}); }}><ArrowLeft />{pending === "previous" ? "Changing…" : "Previous section"}</Button>
      <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={!enabled || pending !== null} onClick={() => { void onChange("next").catch(() => {}); }}><ArrowRight />{pending === "next" ? "Changing…" : "Next section"}</Button>
      <Button type="button" variant="outline" className="min-h-11 min-w-11" disabled={!enabled || pending !== null} onClick={() => { void onChange("clear").catch(() => {}); }}><Eraser />{pending === "clear" ? "Clearing…" : "Clear lyrics"}</Button>
    </div>
    {keyboard && <p className="text-xs text-board-muted">Use ← / → or a keyboard footswitch while this page has focus. Shortcuts pause while editing or using a dialog.</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
  </div>;
}
