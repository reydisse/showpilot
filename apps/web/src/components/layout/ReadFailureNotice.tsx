import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { Button } from "@/components/ui/button";
import type { OperatorReadFailure } from "@/hooks/useOperatorRead";

export function ReadFailureNotice({ error, refreshing, retry, label }: {
  error: OperatorReadFailure | null;
  refreshing: boolean;
  retry: () => void;
  label: string;
}) {
  if (!error) return null;
  return <div role="alert" aria-label={label} className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-400/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
    <p className="min-w-0 flex-1 basis-60">{plainFailure(error.message, "This view could not be updated.")} </p>
    <Button type="button" variant="outline" className="min-h-11" aria-label={label} disabled={refreshing} onClick={retry}>{refreshing ? <QuietActivity label="Retrying…" /> : label}</Button>
  </div>;
}
