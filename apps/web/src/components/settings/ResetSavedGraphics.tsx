import { useState } from "react";
import {
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { resetLowerThirdLibrary } from "@/lib/lowerthirds";
import {
  graphicLibraryResetSchema,
  graphicLibraryResetResultSchema,
  type GraphicLibraryReset,
} from "@/lib/graphic-library-reset-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ResetSavedGraphics({
  orgId,
  orgName,
  userId,
  disabled = false,
}: {
  orgId: string;
  orgName: string;
  userId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const client = useQueryClient();
  const mutationKey = ["reset-saved-graphics", orgId, userId];
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = graphicLibraryResetSchema.safeParse(
        mutation.state.variables,
      );
      const result = graphicLibraryResetResultSchema.safeParse(
        mutation.state.data,
      );
      return {
        status: mutation.state.status,
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
        error: mutation.state.error,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1);
  const pending = latest?.status === "pending";
  const unfinished =
    latest?.command &&
    (latest.status === "pending" ||
      latest.status === "error")
      ? latest.command
      : null;
  const mutation = useMutation({
    mutationKey,
    gcTime: Infinity,
    retry: false,
    networkMode: "always",
    mutationFn: async (command: GraphicLibraryReset) => {
      const controller = new AbortController();
      try {
        return graphicLibraryResetResultSchema.parse(
          await withOperationTimeout(
            resetLowerThirdLibrary({ data: command, signal: controller.signal }),
            10_000,
            "The reset was not confirmed. Retry the same request to check its result.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSettled: () => {
      for (const item of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (item.state.status !== "pending")
          client.getMutationCache().remove(item);
    },
  });
  return (
    <section
      aria-label="Reset saved graphics"
      className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4"
    >
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setName("");
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-board-text">
              Reset saved graphics
            </p>
            <p className="text-xs text-board-muted">
              Delete every saved graphic from this organization.
            </p>
          </div>
          <DialogTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 text-red-300"
              disabled={disabled || Boolean(unfinished)}
            >
              Reset saved graphics
            </Button>
          </DialogTrigger>
        </div>
        <DialogContent
          showCloseButton={false}
          className="max-h-[90dvh] grid-cols-[minmax(0,1fr)] overflow-y-auto bg-board-card text-board-text"
        >
          <DialogHeader>
            <DialogTitle>Reset saved graphics?</DialogTitle>
            <DialogDescription>
              This permanently deletes all saved graphics in {orgName}.
              Saved scenes and uploaded files are kept. If graphics are on air,
              clear Program in Graphics before resetting this library.
              Retrying this request will not delete graphics saved after the reset.
            </DialogDescription>
          </DialogHeader>
          <label className="min-w-0 space-y-2 text-sm">
            Type the organization name:{" "}
            <strong className="break-words">{orgName}</strong>
            <input
              aria-label="Organization name to reset graphics"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="off"
              className="mt-2 min-h-11 w-full rounded-lg border border-board-border bg-board-bg px-3 focus-visible:outline-2 focus-visible:outline-fire-500"
            />
          </label>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-0 whitespace-normal"
              onClick={() => {
                setOpen(false);
                setName("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-auto min-h-11 min-w-0 whitespace-normal"
              disabled={name !== orgName || pending}
              onClick={() => {
                if (name !== orgName || unfinished) return;
                mutation.mutate({
                  orgId,
                  confirmName: name,
                  requestId: crypto.randomUUID(),
                });
                setOpen(false);
                setName("");
              }}
            >
              Permanently delete saved graphics
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {pending ? (
        <p role="status" className="text-sm text-board-muted">
          Resetting saved graphics… Waiting for confirmation.
        </p>
      ) : null}
      {unfinished && !pending ? (
        <div role="alert" className="space-y-2 text-sm text-amber-200">
          <p>
            {latest?.error instanceof Error
              ? latest.error.message
              : "The graphics reset was not confirmed."}{" "}
            Retry checks the same request and keeps graphics saved after the reset.
          </p>
          {latest ? (
            <p>
              Last attempt{" "}
              <time dateTime={new Date(latest.at).toISOString()}>
                {new Date(latest.at).toLocaleTimeString()}
              </time>
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="h-auto min-h-11 min-w-0 whitespace-normal"
            onClick={() => mutation.mutate(unfinished)}
          >
            Retry graphics reset
          </Button>
        </div>
      ) : null}
      {!unfinished && latest?.result ? (
        <p role="status" className="text-sm text-board-muted">
          Saved graphics reset confirmed. {latest.result.deletedCount} saved
          {latest.result.deletedCount === 1 ? " graphic was" : " graphics were"} deleted.
          Graphics saved after the reset are kept.
        </p>
      ) : null}
    </section>
  );
}
