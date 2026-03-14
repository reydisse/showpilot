import { useState, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
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
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="bg-board-card border-board-border sm:max-w-md"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                variant === "danger"
                  ? "bg-red-500/15 border border-red-500/25"
                  : "bg-yellow-500/15 border border-yellow-500/25"
              }`}
            >
              <AlertTriangle
                className={`w-5 h-5 ${
                  variant === "danger" ? "text-red-400" : "text-yellow-400"
                }`}
              />
            </div>
            <div>
              <DialogTitle className="text-board-text text-base">
                {title}
              </DialogTitle>
              <DialogDescription className="text-board-muted text-sm mt-1">
                {description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-4 gap-2 sm:gap-2">
          <button
            onClick={() => onOpenChange(false)}
            disabled={loading}
            className="px-4 py-2 rounded-xl text-sm font-medium text-board-text bg-board-bg border border-board-border hover:bg-board-border/50 transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            disabled={loading}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors disabled:opacity-50 ${
              variant === "danger"
                ? "bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25"
                : "bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 hover:bg-yellow-500/25"
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
      variant?: "danger" | "warning";
    }): Promise<boolean> => {
      return new Promise((resolve) => {
        setState({
          open: true,
          title: opts.title,
          description: opts.description,
          confirmLabel: opts.confirmLabel,
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
      variant={state.variant}
      onConfirm={handleConfirm}
    />
  );

  return { confirm, ConfirmDialogEl };
}
