import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ShowCreationForm } from "@/components/shows/ShowCreationForm";
import type { OpenCreatedShow } from "@/hooks/useShowCreation";
function nextStartTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "10:00";
  const hours = Number(match[1]),
    minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "10:00";
  const next = Math.min(hours * 60 + minutes + 60, 23 * 60 + 59);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}
export function NewShowModal({
  orgId,
  userId,
  currentDate,
  currentStartTime,
  currentShowId,
  timeZone,
  onCreated,
  beforeCreate,
  onClose,
}: {
  orgId: string;
  userId: string;
  currentDate: string;
  currentStartTime: string;
  currentShowId?: string;
  timeZone: string;
  onCreated: OpenCreatedShow;
  beforeCreate: (signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="rundown-modal block max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border border-board-border bg-board-card p-5 shadow-2xl sm:max-w-md"
      >
        <DialogTitle className="mb-4 text-base font-semibold text-board-text">
          New show
        </DialogTitle>
        <ShowCreationForm
          scope={{ orgId, userId, entry: "rundown" }}
          requireStart
          onClose={onClose}
          onCreated={onCreated}
          beforeCreate={beforeCreate}
          shows={
            currentShowId
              ? [
                  {
                    id: currentShowId,
                    serviceDate: currentDate,
                    name: "Current rundown",
                  },
                ]
              : []
          }
          initial={{
            serviceDate: currentDate,
            name: "",
            startTime: nextStartTime(currentStartTime),
            callTime: "",
            location: "",
            timeZone,
            source: currentShowId
              ? {
                  kind: "show",
                  id: currentShowId,
                  serviceDate: currentDate,
                  name: "Current rundown",
                }
              : { kind: "blank" },
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
