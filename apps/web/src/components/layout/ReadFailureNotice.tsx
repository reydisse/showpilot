import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { Button } from "@/components/ui/button";
import type { OperatorReadFailure } from "@/hooks/useOperatorRead";

export function ReadFailureNotice({ error, refreshing, retry, label, title, description }: {
  error: OperatorReadFailure | null;
  refreshing: boolean;
  retry: () => void;
  label: string;
  title?: string;
  description?: string;
}) {
  if (!error) return null;
  return <div role="alert" aria-label={label} className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-board-text">
    <p className="min-w-0 flex-1 basis-60">{title ?? plainFailure(error.message, "This view could not be updated.")}{description && <span className="mt-1 block text-xs text-board-muted">{description}</span>} </p>
    <Button type="button" variant="outline" className="min-h-11" aria-label={label} disabled={refreshing} onClick={retry}>{refreshing ? <QuietActivity label="Retrying…" /> : label}</Button>
  </div>;
}
