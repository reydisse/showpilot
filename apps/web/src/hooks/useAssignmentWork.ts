import { refreshRetainedResult } from "@/lib/retained-refresh";
import { useCallback, useSyncExternalStore } from "react";
import {
  hashKey,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  getScheduleAssignment,
  changeScheduleAssignment,
} from "@/lib/schedule-assignment";
import {
  assignmentSnapshotSchema,
  scheduleAssignmentResultSchema,
  type ScheduleAssignmentCommand,
  type ScheduleAssignmentResult,
} from "@/lib/schedule-assignment-contract";
import { runRouteLoad } from "@/lib/route-load-deadlines";

type Scope = { orgId: string; userId: string; editorId: string };
type Attempt = {
  commands: ScheduleAssignmentCommand[];
  results: (ScheduleAssignmentResult | null)[];
  pending: boolean;
  refresh: "pending" | "done" | "failed";
};
const keys = (scope: Scope) => ({
  attempt: ["assignment-attempt", scope.userId, scope.orgId, scope.editorId],
  draft: ["assignment-draft", scope.userId, scope.orgId, scope.editorId],
  snapshot: ["assignment-snapshot", scope.userId, scope.orgId, scope.editorId],
});
function retryable(result: ScheduleAssignmentResult | null) {
  return (
    !result ||
    (result.outcome === "applied" &&
      result.invitation &&
      ["failed", "uncertain", "sending", "unavailable"].includes(
        result.invitation.email,
      ))
  );
}
async function refreshResult(
  client: QueryClient,
  scope: Scope,
  attempt: Attempt,
  refresh: () => Promise<void>,
  retry = false,
) {
  return refreshRetainedResult<Attempt>({
    client,
    key: keys(scope).attempt,
    refresh,
    begin: (current) => {
      if (
        !current ||
        current.pending ||
        current.refresh === "pending" ||
        (retry && current.refresh !== "failed")
      )
        return null;
      if (
        current.commands.length !== attempt.commands.length ||
        current.commands.some(
          (command, i) => command.requestId !== attempt.commands[i].requestId,
        )
      )
        return null;
      return {
        pending: { ...current, refresh: "pending" },
        done: { ...current, refresh: "done" },
        failed: () => ({ ...current, refresh: "failed" }),
      };
    },
  });
}

async function execute(
  client: QueryClient,
  scope: Scope,
  attempt: Attempt,
  refresh: () => Promise<void>,
) {
  const key = keys(scope);
  const live = client.getQueryData<Attempt | null>(key.attempt);
  if (live?.pending || live?.refresh === "pending") return;
  client.setQueryData(key.attempt, { ...attempt, pending: true });
  const results = await Promise.all(
    attempt.commands.map(async (command, index) => {
      const previous = attempt.results[index];
      if (!retryable(previous)) return previous;
      try {
        return await runRouteLoad(
          async (controller) => {
            const result = scheduleAssignmentResultSchema.parse(
              await changeScheduleAssignment({
                data: command,
                signal: controller.signal,
              }),
            );
            controller.signal.throwIfAborted();
            if (result.requestId !== command.requestId)
              throw new Error(
                "Assignment acknowledgement does not match this save.",
              );
            return result;
          },
          undefined,
          15_000,
        );
      } catch {
        return previous;
      }
    }),
  );
  const next: Attempt = {
    ...attempt,
    results,
    pending: false,
    refresh: "done",
  };
  client.setQueryData(key.attempt, next);
  if (results.some(Boolean)) await refreshResult(client, scope, next, refresh);
}

/** Draft and frozen commands belong to an account, organization and editor,
 * so closing a dialog or navigating away does not discard an uncertain save. */
export function useAssignmentWork<Draft>(
  scope: Scope,
  initial: Draft | null,
  assignmentId: string | undefined,
  refresh: () => Promise<void>,
) {
  const client = useQueryClient(),
    key = keys(scope);
  useQuery<Draft | null>({
    queryKey: key.draft,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  // Query observers batch notifications. A controlled input needs the latest
  // draft synchronously, including typing followed immediately by Submit.
  const draftHash = hashKey(key.draft);
  const draft = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === draftHash) notify();
        }),
      [client, draftHash],
    ),
    () => client.getQueryData<Draft | null>(key.draft) ?? null,
    () => client.getQueryData<Draft | null>(key.draft) ?? null,
  );
  const { data: attempt = null } = useQuery<Attempt | null>({
    queryKey: key.attempt,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const snapshot = useQuery({
    queryKey: key.snapshot,
    enabled: Boolean(assignmentId) && !attempt,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      runRouteLoad(
        async (controller) => {
          if (!assignmentId) return null;
          const response = await getScheduleAssignment({
            data: { orgId: scope.orgId, id: assignmentId },
            signal: controller.signal,
          });
          if (
            response.orgId !== scope.orgId ||
            response.userId !== scope.userId
          )
            throw new Error("Your account changed. Reopen Schedule.");
          return response.snapshot
            ? assignmentSnapshotSchema.parse(response.snapshot)
            : null;
        },
        signal,
        8_000,
      ),
  });
  const pending = !!attempt?.pending || attempt?.refresh === "pending";
  return {
    draft,
    attempt,
    snapshot,
    pending,
    uncertain: !!attempt?.results.some((result) => !result),
    canRetry: !!attempt?.results.some(retryable),
    setDraft: (update: (value: Draft | null) => Draft | null) =>
      client.setQueryData<Draft | null>(key.draft, (value) =>
        update(value ?? null),
      ),
    submit: (operations: ScheduleAssignmentCommand["operation"][]) => {
      if (client.getQueryData(key.attempt)) return;
      const commands = operations.map((operation) => ({
        orgId: scope.orgId,
        userId: scope.userId,
        requestId: crypto.randomUUID(),
        operation,
      }));
      void execute(
        client,
        scope,
        {
          commands,
          results: commands.map(() => null),
          pending: false,
          refresh: "done",
        },
        refresh,
      );
    },
    retry: () => {
      if (attempt) void execute(client, scope, attempt, refresh);
    },
    retryRefresh: () => {
      if (attempt && !pending)
        void refreshResult(client, scope, attempt, refresh, true);
    },
    review: (next: Draft | null) => {
      const live = client.getQueryData<Attempt | null>(key.attempt);
      if (
        !live ||
        live.pending ||
        live.refresh !== "done" ||
        live.results.some((result) => !result)
      )
        return;
      client.setQueryData(key.draft, next);
      client.setQueryData(key.attempt, null);
      void client.invalidateQueries({ queryKey: key.snapshot, exact: true });
    },
  };
}
