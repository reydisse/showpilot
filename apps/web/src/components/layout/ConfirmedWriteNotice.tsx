import type { useConfirmedWrite } from "@/hooks/useConfirmedWrite";

const controlClass = "min-h-11 rounded-lg border border-board-border px-3 py-2 text-sm font-medium text-board-text outline-none hover:bg-board-bg focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";

export function ConfirmedWriteNotice({ state, retry, review, reviewing, collectionLabel }: {
  state: ReturnType<typeof useConfirmedWrite>["state"];
  retry: () => void;
  review: () => void;
  reviewing: boolean;
  collectionLabel: "channels" | "devices" | "destinations" | "outputs" | "inputs" | "team";
}) {
  if (state.status === "idle") return null;
  if (state.status === "saving") return <p role="status" className="sr-only">{state.saved ? `Change saved. Refreshing ${collectionLabel}…` : `Saving ${state.label}…`}</p>;
  return <div role="alert" aria-label={`${collectionLabel === "team" ? "Team" : collectionLabel === "channels" ? "Channel" : collectionLabel === "devices" ? "Device" : collectionLabel === "inputs" ? "Input" : collectionLabel === "outputs" ? "Output" : "Destination"} change`} className="space-y-3 rounded-xl border border-amber-400/25 bg-amber-500/10 p-4 text-sm text-amber-200">
    <p>{state.saved ? "This view could not be updated." : "This change needs attention."}</p>
    <div className="flex flex-wrap gap-2">
      <button className={controlClass} disabled={reviewing} onClick={retry}>{state.saved ? "Retry refresh" : "Retry change"}</button>
      <button className={controlClass} disabled={reviewing} onClick={review}>{reviewing ? "Reviewing…" : `Review stored ${collectionLabel}`}</button>
    </div>
  </div>;
}
