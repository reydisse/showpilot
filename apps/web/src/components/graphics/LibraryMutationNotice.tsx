import { QuietActivity } from "@/components/ui/QuietActivity";
import type { useGraphicLibraryMutation } from "@/hooks/useGraphicLibraryMutation";

export function LibraryMutationNotice({ mutation, onConfirmed, label = "Graphics library", retryLabel = "Retry library change" }: {
  mutation: ReturnType<typeof useGraphicLibraryMutation>;
  onConfirmed: () => void;
  label?: string;
  retryLabel?: string;
}) {
  if (!mutation.failure) return mutation.pending ? <QuietActivity label="Saving library change…" /> : null;
  return <div role="alert" aria-label={label} className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
    <p>The library change needs attention.</p>
    <p className="mt-2"></p>
    <button type="button" disabled={mutation.pending} onClick={async () => { if (await mutation.run()) onConfirmed(); }} className="mt-2 min-h-11 rounded-lg border border-amber-400/30 px-3 disabled:opacity-50">{retryLabel}</button>
    <button type="button" disabled={mutation.pending} onClick={mutation.reviewed} className="mt-2 ml-2 min-h-11 rounded-lg border border-amber-400/30 px-3">Continue editing</button>
  </div>;
}
