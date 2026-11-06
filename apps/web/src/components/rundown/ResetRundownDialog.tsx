import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ResetRundownDialog({ open, onOpenChange, playing, onReset }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playing: boolean;
  onReset: () => void;
}) {
  return <ConfirmDialog
    open={open} onOpenChange={onOpenChange}
    title="Reset this rundown timer?"
    description={playing ? "Pause or stop the timer before resetting. The show is currently playing." : "This stops the timer, marks every item upcoming, and clears actual start and end times for all connected operators."}
    confirmLabel="Reset timer" confirmDisabled={playing}
    onConfirm={() => { if (!playing) onReset(); }}
  />;
}
