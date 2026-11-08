import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  getScheduleProvider,
  saveScheduleProvider,
} from "@/lib/schedule-provider";
import {
  scheduleProviderResultSchema,
  scheduleProviderSnapshotSchema,
  type ScheduleProvider,
  type ScheduleProviderCommand,
  type ScheduleProviderConfig,
  type ScheduleProviderResult,
  type ScheduleProviderSnapshot,
} from "@/lib/schedule-provider-contract";
import { runRouteLoad } from "@/lib/route-load-deadlines";

type Scope = { userId: string; orgId: string };
export type ProviderDraft = {
  provider: ScheduleProvider;
  url: string;
  label: string;
};
type Refresh =
  | { kind: "pending" }
  | { kind: "done" }
  | { kind: "failed"; at: number };
type Attempt =
  | { kind: "pending"; command: ScheduleProviderCommand }
  | { kind: "failed"; command: ScheduleProviderCommand; at: number }
  | { kind: "confirmed"; result: ScheduleProviderResult; refresh: Refresh };
const keys = (scope: Scope) => ({
  snapshot: ["schedule-provider", scope.userId, scope.orgId],
  attempt: ["schedule-provider-attempt", scope.userId, scope.orgId],
  draft: ["schedule-provider-draft", scope.userId, scope.orgId],
});

async function refreshSchedule(
  client: QueryClient,
  scope: Scope,
  result: ScheduleProviderResult,
  refresh: () => Promise<void>,
) {
  const key = keys(scope).attempt;
  client.setQueryData<Attempt>(key, () => ({
    kind: "confirmed",
    result,
    refresh: { kind: "pending" },
  }));
  try {
    await runRouteLoad(() => refresh(), undefined, 12_000);
    client.setQueryData<Attempt>(key, () => ({
      kind: "confirmed",
      result,
      refresh: { kind: "done" },
    }));
  } catch {
    client.setQueryData<Attempt>(key, () => ({
      kind: "confirmed",
      result,
      refresh: { kind: "failed", at: Date.now() },
    }));
  }
}
async function execute(
  client: QueryClient,
  command: ScheduleProviderCommand,
  refresh: () => Promise<void>,
) {
  const key = keys(command);
  const previous = client.getQueryData<Attempt | null>(key.attempt);
  if (
    previous?.kind === "pending" ||
    (previous?.kind === "confirmed" && previous.refresh.kind === "pending")
  )
    return;
  client.setQueryData<Attempt>(key.attempt, () => ({
    kind: "pending",
    command,
  }));
  try {
    await client.cancelQueries({ queryKey: key.snapshot, exact: true });
    const result = await runRouteLoad(
      async (controller) => {
        const result = scheduleProviderResultSchema.parse(
          await saveScheduleProvider({
            data: command,
            signal: controller.signal,
          }),
        );
        controller.signal.throwIfAborted();
        if (
          result.requestId !== command.requestId ||
          result.snapshot.orgId !== command.orgId ||
          result.snapshot.userId !== command.userId
        )
          throw new Error(
            "The scheduling acknowledgement belongs to a different change.",
          );
        return result;
      },
      undefined,
      8_000,
    );
    client.setQueryData<ScheduleProviderSnapshot>(
      key.snapshot,
      result.snapshot,
    );
    // Keep the submitted draft after a conflict so the operator can review it.
    if (result.outcome === "applied") client.setQueryData(key.draft, null);
    await refreshSchedule(client, command, result, refresh);
  } catch {
    client.setQueryData<Attempt>(key.attempt, () => ({
      kind: "failed",
      command,
      at: Date.now(),
    }));
  }
}

export function useScheduleProvider(
  scope: Scope,
  open: boolean,
  refresh: () => Promise<void>,
) {
  const client = useQueryClient(),
    key = keys(scope);
  const { data: attempt = null } = useQuery<Attempt | null>({
    queryKey: key.attempt,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const { data: draft = null } = useQuery<ProviderDraft | null>({
    queryKey: key.draft,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const uncertain = attempt?.kind === "failed";
  const pending =
    attempt?.kind === "pending" ||
    (attempt?.kind === "confirmed" && attempt.refresh.kind === "pending");
  const snapshot = useQuery({
    queryKey: key.snapshot,
    retry: false,
    networkMode: "always",
    enabled: open && !pending && !uncertain,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }) =>
      runRouteLoad(
        async (controller) => {
          const value = scheduleProviderSnapshotSchema.parse(
            await getScheduleProvider({
              data: { orgId: scope.orgId },
              signal: controller.signal,
            }),
          );
          if (value.userId !== scope.userId || value.orgId !== scope.orgId)
            throw new Error("Your account changed. Reopen the schedule.");
          return value;
        },
        signal,
        8_000,
      ),
  });
  const readFailed =
    snapshot.isError ||
    (snapshot.isFetching && snapshot.errorUpdatedAt > snapshot.dataUpdatedAt);
  const locked =
    pending ||
    uncertain ||
    snapshot.isFetching ||
    readFailed ||
    !snapshot.data ||
    (attempt?.kind === "confirmed" && attempt.refresh.kind !== "done");
  return {
    snapshot,
    attempt,
    draft,
    pending,
    uncertain,
    readFailed,
    locked,
    setDraft: (value: ProviderDraft) => client.setQueryData(key.draft, value),
    save: (config: ScheduleProviderConfig) => {
      if (locked || !snapshot.data) return;
      void execute(
        client,
        {
          ...scope,
          config,
          requestId: crypto.randomUUID(),
          expectedRevision: snapshot.data.revision,
        },
        refresh,
      );
    },
    retry: () => {
      if (attempt?.kind === "failed")
        void execute(client, attempt.command, refresh);
    },
    retryRefresh: () => {
      if (attempt?.kind === "confirmed" && attempt.refresh.kind === "failed")
        void refreshSchedule(client, scope, attempt.result, refresh);
    },
    useSaved: () => {
      if (locked) return;
      client.setQueryData(key.draft, null);
      client.setQueryData(key.attempt, null);
    },
  };
}
