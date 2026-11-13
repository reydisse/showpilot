import { useState } from "react";
import { SkipBack, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ProPresenterSlideControls({
  scope,
  disabled,
  onCommand,
}: {
  scope: string;
  disabled: boolean;
  onCommand: (command: "previous" | "next" | "clear") => void;
}) {
  const [review, setReview] = useState<string | null>(null);
  const changed = review !== null && review !== scope;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          title="Previous slide"
          disabled={disabled || review !== null}
          className="min-h-11 h-auto whitespace-normal"
          onClick={() => onCommand("previous")}
        >
          <SkipBack className="size-4" />
          Previous slide
        </Button>
        <Button
          type="button"
          variant="outline"
          title="Next slide"
          disabled={disabled || review !== null}
          className="min-h-11 h-auto whitespace-normal"
          onClick={() => onCommand("next")}
        >
          Next slide
          <SkipForward className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          title="Clear slide layer"
          disabled={disabled || review !== null}
          className="min-h-11 h-auto whitespace-normal border-red-500/30 text-red-400"
          onClick={() => setReview(scope)}
        >
          <X className="size-4" />
          Clear slide
        </Button>
      </div>
      <ConfirmDialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open) setReview(null);
        }}
        title="Clear the live ProPresenter slide?"
        description={
          changed
            ? "The show or ProPresenter settings changed. Cancel and review the current output before clearing it."
            : "This removes the current presentation slide from ProPresenter output for everyone watching."
        }
        confirmLabel="Clear ProPresenter slide"
        confirmDisabled={disabled || changed}
        onConfirm={() => {
          if (!disabled && review === scope) onCommand("clear");
        }}
      />
    </>
  );
}
