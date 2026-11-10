import type { useGraphicLibraryMutation } from "@/hooks/useGraphicLibraryMutation";

export function LibraryMutationNotice({ mutation, onConfirmed }: {
  mutation: ReturnType<typeof useGraphicLibraryMutation>;
  onConfirmed: () => void;
}) {
  if (!mutation.failure) return mutation.pending ? <p role="status" className="text-sm text-board-muted">Waiting for library confirmation…</p> : null;
  return <div role="alert" aria-label="Graphics library confirmation" className="rounded-xl border border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
    <p>{mutation.failure.message} <time dateTime={new Date(mutation.failure.occurredAt).toISOString()}>{new Date(mutation.failure.occurredAt).toLocaleTimeString()}</time></p>
    <p className="mt-2">Check the library before changing the draft or starting another action. An unconfirmed change may already have applied.</p>
    <button type="button" disabled={mutation.pending} onClick={async () => { if (await mutation.run()) onConfirmed(); }} className="mt-2 min-h-11 rounded-lg border border-amber-400/30 px-3 disabled:opacity-50">Retry library change</button>
    <button type="button" disabled={mutation.pending} onClick={mutation.reviewed} className="mt-2 ml-2 min-h-11 rounded-lg border border-amber-400/30 px-3">I’ve checked the library</button>
  </div>;
}
