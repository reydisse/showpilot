import { useEffect } from "react";

export function CueUndoNotice({ label, expiresAt, disabled, onUndo, onExpire }: {
  label: string; expiresAt: number; disabled: boolean; onUndo: () => void; onExpire: () => void;
}) {
  useEffect(() => {
    const timeout = setTimeout(onExpire, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [expiresAt, onExpire]);
  return <div role="status" className="cue-undo-notice"><span>{label} deleted</span><button type="button" className="cue-button" disabled={disabled} onClick={onUndo}>Undo</button></div>;
}
