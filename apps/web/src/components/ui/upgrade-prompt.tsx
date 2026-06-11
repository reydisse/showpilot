import { Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

// Plan-limit errors from src/lib/plan-limits.ts all end with this
// phrase — it doubles as the client-side detection marker.
const PLAN_LIMIT_MARKER = "Upgrade in Settings → Billing";

export function isPlanLimitError(message: string | null | undefined): boolean {
  return Boolean(message && message.includes(PLAN_LIMIT_MARKER));
}

interface UpgradePromptProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  message: string;
  onUpgrade: () => void;
}

/** Shown when a plan limit blocks an action; links to settings → billing. */
export function UpgradePrompt({ open, onOpenChange, message, onUpgrade }: UpgradePromptProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="bg-board-card border-board-border sm:max-w-md"
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-fire-500/15 border border-fire-500/25">
              <Zap className="w-5 h-5 text-fire-500" />
            </div>
            <div>
              <DialogTitle className="text-board-text text-base">
                Plan limit reached
              </DialogTitle>
              <DialogDescription className="text-board-muted text-sm mt-1">
                {message.replace(` ${PLAN_LIMIT_MARKER}.`, "")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <button
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 rounded-lg text-sm text-board-muted border border-board-border hover:text-board-text hover:bg-board-border/50 transition-colors"
          >
            Maybe later
          </button>
          <button
            onClick={onUpgrade}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-fire-500 text-white hover:bg-fire-600 transition-colors"
          >
            View plans
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
