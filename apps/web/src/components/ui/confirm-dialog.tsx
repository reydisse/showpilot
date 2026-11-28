import { useState, useCallback } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "warning";
  onConfirm: () => void;
  loading?: boolean;
  confirmDisabled?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  loading = false,
  confirmDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="schedule-a flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-0 overflow-hidden rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 text-board-text shadow-[0_24px_64px_rgba(0,0,0,0.6)] sm:max-w-[440px]"
      >
        <DialogHeader className="flex flex-row items-start justify-between gap-4 px-5 pb-4 pt-5 text-left">
          <div className="flex min-w-0 flex-col gap-2">
            <DialogTitle className="text-base font-semibold tracking-[-0.01em] text-board-text">{title}</DialogTitle>
            <DialogDescription className="text-[13px] leading-[1.55] text-[var(--sa-ink-2)]">{description}</DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            aria-label={`Close ${title}`}
            className="-mr-1.5 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text max-lg:-mr-3 max-lg:-mt-2.5 max-lg:h-11 max-lg:w-11"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogHeader>
        <DialogFooter className="flex flex-row flex-wrap items-center justify-end gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5 sm:justify-end">
          <span className="mr-auto hidden items-center gap-1.5 text-xs text-[var(--sa-ink-3)] sm:inline-flex">
            <kbd className="rounded border border-[var(--sa-border-strong)] px-1.5 text-xs">Esc</kbd> to cancel
          </span>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="inline-flex h-8 items-center rounded-lg border border-[var(--sa-border-strong)] bg-[var(--sa-surface-2)] px-3 text-[13px] font-medium text-board-text hover:bg-[var(--sa-surface-3)] focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 max-lg:h-11"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            disabled={loading || confirmDisabled}
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-3 text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 max-lg:h-11 ${
              variant === "danger"
                ? "border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10 text-[var(--sa-danger)] hover:bg-[var(--sa-danger)]/15"
                : "border-[var(--sa-warn)]/30 bg-[var(--sa-warn)]/10 text-[var(--sa-warn)] hover:bg-[var(--sa-warn)]/15"
            }`}
          >
            {loading ? "..." : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hook for confirm dialogs — replaces window.confirm().
 *
 * Usage:
 *   const { confirm, ConfirmDialogEl } = useConfirmDialog();
 *   ...
 *   const ok = await confirm({ title: "Delete?", description: "This cannot be undone." });
 *   if (!ok) return;
 *   ...
 *   return <>{ConfirmDialogEl}</>;
 */
export function useConfirmDialog() {
  const [state, setState] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: "danger" | "warning";
    resolve: ((value: boolean) => void) | null;
  }>({
    open: false,
    title: "",
    description: "",
    resolve: null,
  });

  const confirm = useCallback(
    (opts: {
      title: string;
      description: string;
      confirmLabel?: string;
      cancelLabel?: string;
      variant?: "danger" | "warning";
    }): Promise<boolean> => {
      return new Promise((resolve) => {
        setState({
          open: true,
          title: opts.title,
          description: opts.description,
          confirmLabel: opts.confirmLabel,
          cancelLabel: opts.cancelLabel,
          variant: opts.variant,
          resolve,
        });
      });
    },
    []
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && state.resolve) {
        state.resolve(false);
      }
      setState((prev) => ({ ...prev, open, resolve: open ? prev.resolve : null }));
    },
    [state.resolve]
  );

  const handleConfirm = useCallback(() => {
    if (state.resolve) {
      state.resolve(true);
    }
    setState((prev) => ({ ...prev, open: false, resolve: null }));
  }, [state.resolve]);

  const ConfirmDialogEl = (
    <ConfirmDialog
      open={state.open}
      onOpenChange={handleOpenChange}
      title={state.title}
      description={state.description}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      variant={state.variant}
      onConfirm={handleConfirm}
    />
  );

  return { confirm, ConfirmDialogEl };
}
