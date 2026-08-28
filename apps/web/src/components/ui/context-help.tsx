import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function ContextHelp({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Help: ${title}`}
          title={`About ${title}`}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-board-border bg-board-card text-board-muted transition hover:border-fire-500/40 hover:text-fire-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fire-500/50",
            className,
          )}
        >
          <CircleHelp className="size-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="border-board-border bg-board-card text-board-text sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="leading-6 text-board-muted">
            {description}
          </DialogDescription>
        </DialogHeader>
        {children ? <div className="text-sm leading-6 text-board-muted">{children}</div> : null}
      </DialogContent>
    </Dialog>
  );
}
