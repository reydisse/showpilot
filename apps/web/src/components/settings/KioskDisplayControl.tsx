import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { getKioskBlankState, setKioskBlankState } from "@/lib/kiosk-display";
import {
  kioskDisplayCommandSchema,
  kioskDisplayResultSchema,
  kioskDisplaySnapshotSchema,
  type KioskDisplayCommand,
} from "@/lib/kiosk-display-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";

export function KioskDisplayControl({
  orgId,
  userId,
}: {
  orgId: string;
  userId: string;
}) {
  const client = useQueryClient();
  const queryKey = ["kiosk-display-state", orgId, userId];
  const mutationKey = ["kiosk-display-command", orgId, userId];
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [confirming, setConfirming] = useState(false);
  const state = useQuery({
    queryKey,
    retry: false,
    networkMode: "always",
    refetchInterval: 5_000,
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        return kioskDisplaySnapshotSchema.parse(
          await withOperationTimeout(
            getKioskBlankState({ data: { orgId }, signal: controller.signal }),
            8_000,
            "Display state could not be confirmed. Retry the read before changing it.",
          ),
        );
      } finally {
        signal.removeEventListener("abort", cancel);
        controller.abort();
      }
    },
  });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = kioskDisplayCommandSchema.safeParse(
        mutation.state.variables,
      );
      const result = kioskDisplayResultSchema.safeParse(mutation.state.data);
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
    latest?.command && (pending || latest.status === "error")
      ? latest.command
      : null;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    onMutate: () => client.cancelQueries({ queryKey, exact: true }),
    mutationFn: async (command: KioskDisplayCommand) => {
      const controller = new AbortController();
      try {
        return kioskDisplayResultSchema.parse(
          await withOperationTimeout(
            setKioskBlankState({ data: command, signal: controller.signal }),
            10_000,
            "Display command was not confirmed. Retry the same command to recover its result.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData(queryKey, result.snapshot);
    },
    onSettled: () => {
      for (const entry of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (entry.state.status !== "pending")
          client.getMutationCache().remove(entry);
    },
  });
  const change = async () => {
    const reviewed = state.data;
    if (!reviewed || state.isError || unfinished || confirming) return;
    if (!reviewed.blanked) {
      setConfirming(true);
      const accepted = await confirm({
        title: "Blank all kiosk displays?",
        description:
          "Every kiosk in this organization will show a blank slate on its next poll. Use Restore displays to show content again.",
        confirmLabel: "Blank displays",
        variant: "warning",
      });
      setConfirming(false);
      if (!accepted) return;
    }
    mutation.mutate({
      orgId,
      requestId: crypto.randomUUID(),
      expectedRevision: reviewed.revision,
      blanked: !reviewed.blanked,
    });
  };
  return (
    <section
      aria-label="Kiosk display control"
      className="mb-5 space-y-3 rounded-xl border border-board-border bg-board-card p-4"
    >
      {ConfirmDialogEl}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-board-text">
            Kiosk displays
          </h2>
          <p role="status" className="text-sm text-board-muted">
            {!state.data
              ? state.isError
                ? "Display state is unavailable."
                : "Reading display state…"
              : `${state.isError ? "Last confirmed: " : ""}${state.data.blanked ? "Displays are set to show a blank slate." : "Displays are set to show their content."}`}
          </p>
          <p className="mt-1 text-xs text-board-muted">
            Connected kiosks apply this setting on their next poll.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 whitespace-normal"
          disabled={
            !state.data || state.isError || Boolean(unfinished) || confirming
          }
          onClick={() => void change()}
        >
          {state.data?.blanked ? "Restore displays" : "Blank all displays"}
        </Button>
      </div>
      {state.isError ? (
        <div
          role="alert"
          aria-label="Display state error"
          className="space-y-2 text-sm text-amber-200"
        >
          <p>
            {state.error instanceof Error
              ? state.error.message
              : "Display state could not be read."}
          </p>
          <p>
            Last failed read{" "}
            <time dateTime={new Date(state.errorUpdatedAt).toISOString()}>
              {new Date(state.errorUpdatedAt).toLocaleTimeString()}
            </time>
          </p>
          <Button
            className="h-auto min-h-11 whitespace-normal"
            variant="outline"
            onClick={() => void state.refetch()}
          >
            Retry display state
          </Button>
        </div>
      ) : null}
      {pending ? (
        <p role="status" className="text-sm text-board-muted">
          Waiting for the display command to be confirmed…
        </p>
      ) : null}
      {unfinished && !pending ? (
        <div
          role="alert"
          aria-label="Display command error"
          className="space-y-2 text-sm text-amber-200"
        >
          <p>
            {latest?.error instanceof Error
              ? latest.error.message
              : "The display command was not confirmed."}{" "}
            Retry checks the original command and will not overwrite a later
            controller change.
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
            className="h-auto min-h-11 whitespace-normal"
            variant="outline"
            onClick={() => mutation.mutate(unfinished)}
          >
            Retry display command
          </Button>
        </div>
      ) : null}
      {!unfinished && latest?.result ? (
        <p
          role={latest.result.outcome === "applied" ? "status" : "alert"}
          className="text-sm text-board-muted"
        >
          {latest.result.outcome === "applied"
            ? "Display command saved. Kiosks apply it when connected."
            : latest.result.outcome === "superseded"
              ? "The original command was saved, then another controller changed the display setting. The latest state is shown above."
              : "The display setting changed after you reviewed it. Your command was not applied. Review the latest state above before trying again."}
        </p>
      ) : null}
    </section>
  );
}
