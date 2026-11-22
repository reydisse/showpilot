import { useEffect, useRef, useState } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { Button } from "@/components/ui/button";
import type { OperatorReadFailure } from "@/hooks/useOperatorRead";

export function ReadFailureNotice({ error, refreshing, retry, label, title, description, variant = "inline" }: {
  error: OperatorReadFailure | null;
  refreshing: boolean;
  retry: () => void;
  label: string;
  title?: string;
  description?: string;
  /** "panel": Schedule — A failure panel (icon, Try again in place, "Still couldn't load" after a failed retry). */
  variant?: "inline" | "panel";
}) {
  if (variant === "panel") return <ReadFailurePanel error={error} refreshing={refreshing} retry={retry} label={label} title={title} description={description} />;
  if (!error) return null;
  return <div role="alert" aria-label={label} className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-board-text">
    <p className="min-w-0 flex-1 basis-60">{title ?? plainFailure(error.message, "This view could not be updated.")}{description && <span className="mt-1 block text-xs text-board-muted">{description}</span>} </p>
    <Button type="button" variant="outline" className="min-h-11" aria-label={label} disabled={refreshing} onClick={retry}>{refreshing ? <QuietActivity label="Retrying…" /> : label}</Button>
  </div>;
}

function ReadFailurePanel({ error, refreshing, retry, label, title, description }: {
  error: OperatorReadFailure | null;
  refreshing: boolean;
  retry: () => void;
  label: string;
  title?: string;
  description?: string;
}) {
  const [retried, setRetried] = useState(false);
  const [failedAgain, setFailedAgain] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!error) { setRetried(false); setFailedAgain(false); return; }
    if (retried && !refreshing) { setFailedAgain(true); button.current?.focus(); }
  }, [error, refreshing, retried]);
  if (!error) return null;
  return <div role="alert" aria-label={label} className="flex items-start gap-3 rounded-xl border border-[var(--sa-danger,#f87171)]/30 bg-[var(--sa-danger,#f87171)]/[0.07] p-4">
    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--sa-danger,#f87171)]" strokeWidth={1.75} />
    <div className="min-w-0 flex-1">
      <p className="text-[13px] font-semibold text-board-text">{title ?? plainFailure(error.message, "This view could not be updated.")}</p>
      {description ? <p className="mt-1 text-[13px] leading-[1.55] text-[var(--sa-ink-2,#a8a8b3)]">{description}</p> : null}
      {failedAgain && !refreshing ? <p className="mt-2 flex items-center gap-2 text-[13px] font-medium text-board-text"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--sa-danger,#f87171)]" />Still couldn't load. Check your connection.</p> : null}
    </div>
    <button ref={button} type="button" aria-label={label} disabled={refreshing} onClick={() => { setRetried(true); setFailedAgain(false); retry(); }}
      className="inline-flex h-8 min-w-[104px] max-lg:h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--sa-border-strong,#34343a)] bg-[var(--sa-surface-2,#1a1a1d)] px-2.5 text-xs font-medium text-board-text hover:bg-[var(--sa-surface-3,#222226)] disabled:opacity-40">
      <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />{refreshing ? "Trying again…" : label}
    </button>
  </div>;
}
