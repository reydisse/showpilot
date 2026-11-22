import type React from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * Schedule — A modal shell (Doop canvas aneicgaHqk, "Modals — A").
 * Fields inside `.sp-modal-a` pick up the A control style from styles.css.
 */
export const modalFooter =
  "-mx-5 -mb-5 mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--sa-border)] bg-board-bg px-5 py-3.5";
export const modalCancel =
  "inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-[var(--sa-ink-2)] hover:bg-[var(--sa-surface-2)] hover:text-board-text disabled:opacity-40";
export const modalPrimary =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-fire-500 px-3 text-[13px] font-semibold text-[#1a1300] hover:bg-fire-400 disabled:opacity-40";
export const modalDanger =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[var(--sa-danger)]/30 bg-[var(--sa-danger)]/10 px-3 text-[13px] font-semibold text-[var(--sa-danger)] disabled:opacity-40";
export const modalHint = "mt-1.5 block text-xs font-normal leading-[1.45] text-[var(--sa-ink-3)]";

export function ModalAContent({
  title,
  description,
  onClose,
  closeLabel,
  onCloseAutoFocus,
  children,
  className = "",
}: {
  title: string;
  description: React.ReactNode;
  onClose: () => void;
  closeLabel?: string;
  onCloseAutoFocus?: (event: Event) => void;
  children: React.ReactNode;
  /** Extra classes, e.g. a wider max width. */
  className?: string;
}) {
  return (
    <DialogContent
      showCloseButton={false}
      onCloseAutoFocus={onCloseAutoFocus}
      className={`schedule-a sp-modal-a flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col gap-0 overflow-hidden rounded-[14px] border-[var(--sa-border-strong)] bg-[var(--sa-surface)] p-0 text-board-text shadow-[0_24px_64px_rgba(0,0,0,0.6)] sm:max-w-[480px] [&_button]:outline-none [&_button]:focus-visible:ring-2 [&_button]:focus-visible:ring-fire-500 ${className}`}
    >
      <header className="flex shrink-0 items-start justify-between gap-4 px-5 pb-1 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">{title}</DialogTitle>
          <DialogDescription className="text-[13px] text-[var(--sa-ink-2)]">{description}</DialogDescription>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel ?? `Close ${title}`}
          className="-mr-1.5 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md max-lg:-mr-3 max-lg:-mt-2.5 max-lg:h-11 max-lg:w-11 text-[var(--sa-ink-3)] hover:bg-[var(--sa-surface-2)] hover:text-board-text"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto px-5 pb-5 pt-4">{children}</div>
    </DialogContent>
  );
}

export function ModalA(props: React.ComponentProps<typeof ModalAContent>) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <ModalAContent {...props} />
    </Dialog>
  );
}
