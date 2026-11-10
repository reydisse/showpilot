import { useCallback, useSyncExternalStore } from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getDutyRosterState,
  writeDutyRoster,
  retryDutyNotifications,
} from "@/lib/duty-roster";
import {
  dutyRosterCommandSchema,
  dutyRosterResultSchema,
  dutyRosterSnapshotSchema,
  type DutyRosterCommand,
  type DutyRosterSnapshot,
} from "@/lib/duty-roster-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";
export type DutyWeekDraft = {
  rolesRevision: number;
  weekRevision: number;
  tech: Record<string, string>;
  pmUserId: string | null;
};
type Drafts = {
  week: string;
  weeks: Record<string, DutyWeekDraft>;
  role: { code: string; name: string; short: string };
};
const draftKey = (orgId: string, userId: string) => [
  "duty-roster-drafts",
  orgId,
  userId,
];
export function useDutyRosterDrafts(
  orgId: string,
  userId: string,
  initialWeek: string,
) {
  const client = useQueryClient(),
    key = draftKey(orgId, userId);
  const { data: initial } = useQuery<Drafts>({
    queryKey: key,
    queryFn: () =>
      ({
        week: initialWeek,
        weeks: {},
        role: { code: "", name: "", short: "" },
      }) satisfies Drafts,
    initialData: () => ({
      week: initialWeek,
      weeks: {},
      role: { code: "", name: "", short: "" },
    }),
    enabled: false,
    gcTime: Infinity,
  });
  const subscribe = useCallback(
    (changed: () => void) => client.getQueryCache().subscribe(changed),
    [client],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => client.getQueryData<Drafts>(key) ?? initial,
    () => initial,
  );
  const update = (change: (previous: Drafts) => Drafts) =>
    client.setQueryData<Drafts>(key, (previous) => change(previous ?? initial));
  return { state, update };
}
export function weekDraft(snapshot: DutyRosterSnapshot): DutyWeekDraft {
  return {
    rolesRevision: snapshot.rolesRevision,
    weekRevision: snapshot.weekRevision,
    tech: { ...snapshot.tech },
    pmUserId: snapshot.pmUserId,
  };
}
export function useDutyRoster(
  orgId: string,
  userId: string,
  weekStart: string,
) {
  const client = useQueryClient(),
    readPrefix = ["duty-roster-state", orgId, userId],
    readKey = [...readPrefix, weekStart],
    mutationKey = ["duty-roster-command", orgId, userId];
  const read = useQuery<DutyRosterSnapshot>({
    queryKey: readKey,
    refetchInterval: (query) =>
      query.state.status === "error" ? false : 30_000,
    retry: false,
    networkMode: "always",
    queryFn: async ({ signal }) => {
      const controller = new AbortController(),
        abort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      try {
        return dutyRosterSnapshotSchema.parse(
          await withOperationTimeout(
            getDutyRosterState({
              data: { orgId, weekStart },
              signal: controller.signal,
            }),
            8_000,
            "The roster could not be confirmed. Retry the read; your selections are retained.",
          ),
        );
      } finally {
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    },
  });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (mutation) => {
      const command = dutyRosterCommandSchema.safeParse(
          mutation.state.variables,
        ),
        result = dutyRosterResultSchema.safeParse(mutation.state.data);
      return {
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
        status: mutation.state.status,
        error: mutation.state.error,
        at: mutation.state.submittedAt,
      };
    },
  });
  const latest = history.at(-1),
    pending = latest?.status === "pending";
  const unfinished =
    latest?.command && (pending || latest.status === "error")
      ? latest.command
      : null;
  const invalidate = async () => {
    await client.cancelQueries({ queryKey: readPrefix });
    await client.invalidateQueries({ queryKey: readPrefix });
  };
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: async (command: DutyRosterCommand) => {
      const controller = new AbortController();
      try {
        return dutyRosterResultSchema.parse(
          await withOperationTimeout(
            writeDutyRoster({ data: command, signal: controller.signal }),
            10_000,
            "Roster command was not confirmed. Retry the same command to recover its result.",
          ),
        );
      } finally {
        controller.abort();
      }
    },
    onSuccess: async (result, command) => {
      await client.cancelQueries({ queryKey: readPrefix });
      const key = [...readPrefix, command.weekStart],
        current = client.getQueryData<DutyRosterSnapshot>(key);
      if (
        !current ||
        (current.rolesRevision <= result.snapshot.rolesRevision &&
          current.weekRevision <= result.snapshot.weekRevision)
      )
        client.setQueryData(key, result.snapshot);
      if (result.outcome === "applied")
        client.setQueryData<Drafts>(draftKey(orgId, userId), (previous) => {
          if (!previous) return previous;
          const weeks = { ...previous.weeks };
          if (command.action === "save-week") delete weeks[command.weekStart];
          return {
            ...previous,
            weeks,
            role:
              command.action === "create-role"
                ? { code: "", name: "", short: "" }
                : previous.role,
          };
        });
      await client.invalidateQueries({
        queryKey: readPrefix,
        predicate: (query) => query.queryKey.at(-1) !== command.weekStart,
      });
    },
    onSettled: () => {
      for (const old of client
        .getMutationCache()
        .findAll({ mutationKey, exact: true }))
        if (old.state.status !== "pending")
          client.getMutationCache().remove(old);
    },
  });
  const notices = useMutation({
    mutationKey: ["duty-notification-retry", orgId, userId],
    retry: false,
    networkMode: "always",
    mutationFn: () =>
      withOperationTimeout(
        retryDutyNotifications({ data: { orgId } }),
        8_000,
        "Duty notification delivery could not be confirmed. Retry delivery.",
      ),
    onSuccess: invalidate,
  });
  const send = (command: DutyRosterCommand) => {
    if (!unfinished && !read.isError) mutation.mutate(command);
  };
  return {
    read,
    latest,
    pending,
    unfinished,
    send,
    retry: () => {
      if (unfinished && !pending) mutation.mutate(unfinished);
    },
    notices,
  };
}
