import { useRetainedRequests } from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  rundownChangeReplySchema,
  type RundownChangeCommand,
  type RundownChangeReply,
} from "../lib/rundown-change-recovery";

type TrackedCommand = RundownChangeCommand & { initiatedAt: number };
type Selection =
  | { action: "remove-item" | "restore-item"; itemId: string }
  | { action: "clear-all" };

export function useRundownChange(
  scope: { orgId: string; userId: string; showId: string; serviceDate: string },
  options: {
    active: boolean;
    send: (
      command: RundownChangeCommand,
      signal: AbortSignal,
    ) => Promise<RundownChangeReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const requests = useRetainedRequests(scope, {
    family: "mobile-rundown-change-request",
    scopeKey: scope.showId,
    enabled: options.active,
    slot: (_command: TrackedCommand) => "change",
    send: async (tracked, signal) => {
      const { initiatedAt: _initiatedAt, ...command } = tracked;
      const result = rundownChangeReplySchema.parse(
        await options.send(command, signal),
      );
      if (result.showId !== command.showId)
        throw new Error("The reply belongs to another show.");
      return result;
    },
    parseResult: (value) => rundownChangeReplySchema.parse(value),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "This rundown action could not be confirmed. It may have completed. Retry the original request to check its outcome.",
    refreshFailureMessage:
      "The rundown could not refresh. Retry to load its current state.",
    refresh: options.refresh,
  });
  const attempt = requests.work.change;
  function confirm(selection: Selection, revision: number, label: string) {
    requests.start(
      {
        ...scope,
        ...selection,
        expectedRevision: revision,
        requestId: createLocalRequestUuid(),
        initiatedAt: Date.now(),
      },
      label,
    );
  }
  return {
    attempt,
    confirm,
    retry: () => requests.retry("change"),
    refresh: () => requests.refresh("change"),
    dismiss: () => requests.dismiss("change"),
    undo: (revision: number) => {
      if (
        !requests.isActive() ||
        attempt?.kind !== "confirmed" ||
        attempt.refresh !== "done" ||
        attempt.result.outcome !== "applied" ||
        attempt.command.action !== "remove-item" ||
        Date.now() >= attempt.command.initiatedAt + 30_000
      )
        return;
      requests.dismiss("change");
      confirm(
        { action: "restore-item", itemId: attempt.command.itemId },
        revision,
        attempt.label,
      );
    },
  };
}
