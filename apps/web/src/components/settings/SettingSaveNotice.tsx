import { CircleCheck, LoaderCircle } from "lucide-react";
import type { SettingSaveState } from "./useSettingAutosave";

export function settingLabel(key: string): string {
  if (key === "default-confidence-layout") return "Confidence layout";
  if (key === "org-timezone") return "Timezone";
  return key.split("-").map((word, index) => word === "propresenter" ? "ProPresenter"
    : word === "api" ? "API" : word === "l3" ? "Lower thirds" : index === 0 ? word[0].toUpperCase() + word.slice(1) : word).join(" ");
}
function displayValue(value: string | null) {
  return value === null || value === "" ? "Not set" : value.length > 160 ? `${value.slice(0, 160)}…` : value;
}
export function SettingSaveNotice({ state, retry, resolveConflict, showStatus = true }: {
  state: SettingSaveState;
  retry: (key: string) => Promise<boolean>;
  resolveConflict: (key: string, choice: "saved" | "mine") => Promise<boolean>;
  showStatus?: boolean;
}) {
  if (state.kind === "saved") return showStatus ? <p role="status" className="flex items-center gap-2 text-xs text-green-400"><CircleCheck className="size-4" />General settings save automatically</p> : null;
  if (state.kind === "saving") return <p role="status" className="flex items-center gap-2 text-xs text-board-muted"><LoaderCircle className="size-4 animate-spin" />Saving changes</p>;
  return <div className="space-y-3">{state.failures.map(failure => <div key={failure.key} role="alert" className="rounded-xl border border-red-400/40 bg-red-500/5 p-3 text-sm">
    <p className="font-medium text-board-text">{settingLabel(failure.key)}</p>
    <p className="mt-1 break-words text-board-muted">{failure.message}</p>
    <p className="mt-1 text-xs text-board-muted">Last error <time dateTime={new Date(failure.occurredAt).toISOString()}>{new Date(failure.occurredAt).toLocaleTimeString()}</time></p>
    {failure.queuedValue !== null && <p className="mt-1 text-board-muted">A newer edit is waiting.</p>}
    {failure.kind === "conflict" && failure.key !== "default-confidence-layout" && <dl className="mt-2 break-words text-board-text">
      <dt className="text-xs text-board-muted">Saved value</dt><dd>{displayValue(failure.currentValue)}</dd>
      <dt className="mt-1 text-xs text-board-muted">Your edit</dt><dd>{displayValue(failure.queuedValue ?? failure.attemptedValue)}</dd>
    </dl>}
    <div className="mt-2 flex flex-wrap gap-2">
      {failure.kind === "uncertain" ? <button type="button" className="min-h-11 rounded-lg border border-board-border px-4 font-medium text-board-text" aria-label={`Retry ${settingLabel(failure.key)}`} onClick={() => void retry(failure.key)}>Retry</button>
        : <>
          <button type="button" className="min-h-11 rounded-lg border border-board-border px-4 font-medium text-board-text" onClick={() => void resolveConflict(failure.key, "saved")}>Use saved value</button>
          <button type="button" className="min-h-11 rounded-lg bg-fire-500 px-4 font-medium text-white" onClick={() => void resolveConflict(failure.key, "mine")}>Apply my edit</button>
        </>}
    </div>
  </div>)}</div>;
}
