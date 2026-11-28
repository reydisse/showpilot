import { plainFailure } from "@showpilot/shared/ui-feedback";
import { QuietActivity } from "@/components/ui/QuietActivity";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import {
  getTechnicalKioskDisplay,
  writeTechnicalKioskDisplay,
} from "@/lib/technical-kiosk-display";
import { getKioskBlankState, setKioskBlankState } from "@/lib/kiosk-display";
import {
  kioskDisplayCommandSchema,
  kioskDisplayResultSchema,
  kioskDisplaySnapshotSchema,
  type KioskDisplayCommand,
  type KioskDisplaySnapshot,
} from "@/lib/kiosk-display-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { CircleCheck, Monitor, RefreshCw, TriangleAlert } from "lucide-react";
import { Callout, Spinner, StatusWord, tmSecondary } from "@/components/dashboard/tm-a";

type Props = {
  orgId: string;
  userId: string;
  surface?: "settings" | "technical";
};
export function KioskDisplayControl(props: Props) {
  return (
    <ScopedKioskDisplayControl
      key={`${props.orgId}:${props.userId}:${props.surface ?? "settings"}`}
      {...props}
    />
  );
}
function ScopedKioskDisplayControl({
  orgId,
  userId,
  surface = "settings",
}: Props) {
  const readDisplay =
    surface === "technical" ? getTechnicalKioskDisplay : getKioskBlankState;
  const writeDisplay =
    surface === "technical" ? writeTechnicalKioskDisplay : setKioskBlankState;
  const client = useQueryClient();
  const readPrefix = ["kiosk-display-state", orgId, userId];
  const queryKey = [...readPrefix, surface];
  const mutationKey = ["kiosk-display-command", orgId, userId];
  const { confirm, ConfirmDialogEl } = useConfirmDialog();
  const [confirming, setConfirming] = useState(false);
  const state = useQuery<KioskDisplaySnapshot>({
    queryKey,
    retry: false,
    networkMode: "always",
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 5_000,
    queryFn: async ({ signal }) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      try {
        return kioskDisplaySnapshotSchema.parse(
          await withOperationTimeout(
            readDisplay({ data: { orgId }, signal: controller.signal }),
            8_000,
            "This change needs attention.",
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
    onMutate: async () => {
      await client.cancelQueries({ queryKey: readPrefix });
      return { readAt: client.getQueryState(queryKey)?.dataUpdatedAt };
    },
    mutationFn: async (command: KioskDisplayCommand) => {
      const controller = new AbortController();
      try {
        return kioskDisplayResultSchema.parse(
          await withOperationTimeout(
            writeDisplay({ data: command, signal: controller.signal }),
            10_000,
            "This change needs attention.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSuccess: async (result, _command, context) => {
      await client.cancelQueries({ queryKey: readPrefix });
      if (client.getQueryState(queryKey)?.dataUpdatedAt === context?.readAt)
        client.setQueryData(queryKey, result.snapshot);
      else void client.invalidateQueries({ queryKey, exact: true });
      void client.invalidateQueries({
        queryKey: readPrefix,
        predicate: (query) => query.queryKey.at(-1) !== surface,
      });
    },
    onSettled: () => {
      for (const entry of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (entry.state.status !== "pending")
          client.getMutationCache().remove(entry);
    },
  });
  const readFailure =
    state.isError ||
    (state.isFetching && state.errorUpdatedAt > state.dataUpdatedAt);
  const change = async () => {
    const reviewed = state.data;
    if (!reviewed || state.isError || unfinished || confirming) return;
    if (!reviewed.blanked) {
      setConfirming(true);
      const accepted = await confirm({
        title: "Blank all displays?",
        description:
          "Every kiosk in this organization will show a blank slate on its next poll. Use Restore displays to show content again.",
        confirmLabel: "Blank all displays",
        variant: "danger",
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
  const sendingBlank = pending && latest?.command?.blanked === true;
  return (
    <section
      aria-label="Kiosk display control"
      className={`schedule-a min-w-0 rounded-xl border border-[var(--sa-border)] bg-[var(--sa-surface)] p-4 ${surface === "settings" ? "mb-5" : ""}`}
    >
      {ConfirmDialogEl}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2.5 text-[15px] font-semibold text-board-text">
            <Monitor aria-hidden="true" className="h-4 w-4 text-[var(--sa-ink-3)]" strokeWidth={1.75} />Kiosk displays
          </h2>
          <div role="status" className="mt-2 text-[13px] text-[var(--sa-ink-2)]">
            {pending ? (
              <span className="inline-flex items-center gap-2 text-board-text"><Spinner />{sendingBlank ? "Blanking displays…" : "Restoring displays…"}</span>
            ) : !state.data ? (
              state.isError ? "Display details could not be loaded." : <QuietActivity label="Loading display" />
            ) : (
              <>
                {state.data.blanked
                  ? <StatusWord tone="muted" icon={Monitor} className="text-board-text">Blank slate</StatusWord>
                  : <StatusWord tone="ok" icon={CircleCheck}>Showing content</StatusWord>}
                <p className="mt-1">{state.data.blanked ? "Displays are set to show a blank slate. Connected kiosks apply this setting on their next poll." : "Displays show their normal content. Connected kiosks apply changes on their next poll."}</p>
              </>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--sa-ink-3)]">Dashboard re-checks every 5s · kiosks poll about once a minute</p>
        </div>
        <button
          type="button"
          className={`${tmSecondary} shrink-0 self-start sm:self-center`}
          disabled={!state.data || state.isError || Boolean(unfinished) || confirming}
          onClick={() => void change()}
        >
          {state.data?.blanked ? "Restore displays" : "Blank all displays"}
        </button>
      </div>
      {readFailure || (unfinished && !pending) || (!unfinished && latest?.result) ? (
        <div className="mt-3 flex flex-col gap-2">
          {readFailure ? (
            <div role="alert" aria-label="Display state error">
              <Callout tone="warn" icon={TriangleAlert} title="Couldn't read display state"
                action={<button type="button" className={tmSecondary} aria-label="Retry display state" disabled={state.isFetching} onClick={() => void state.refetch()}>
                  {state.isFetching ? <QuietActivity label="Retrying…" /> : <><RefreshCw className="h-3.5 w-3.5" />Retry display state</>}
                </button>}>
                {plainFailure((state.error instanceof Error ? state.error.message : "Display state could not be read.") ?? "")}
              </Callout>
            </div>
          ) : null}
          {unfinished && !pending ? (
            <div role="alert" aria-label="Display command error">
              <Callout tone="danger" icon={TriangleAlert} title="This display change needs attention."
                action={<button type="button" className={tmSecondary} onClick={() => mutation.mutate(unfinished)}><RefreshCw className="h-3.5 w-3.5" />Retry display command</button>}>
                {plainFailure((latest?.error instanceof Error ? latest.error.message : "This change needs attention.") ?? "")}{" "}
                Retry checks the original command and will not overwrite a later controller change.
              </Callout>
            </div>
          ) : null}
          {!unfinished && latest?.result ? (
            <p role={latest.result.outcome === "applied" ? "status" : "alert"} className="text-[13px] text-[var(--sa-ink-2)]">
              {latest.result.outcome === "applied"
                ? "Display command saved. Kiosks apply it when connected."
                : latest.result.outcome === "superseded"
                  ? "The original command was saved, then another controller changed the display setting. The latest state is shown above."
                  : "The display setting changed after you reviewed it. Your command was not applied. Review the latest state above before trying again."}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
