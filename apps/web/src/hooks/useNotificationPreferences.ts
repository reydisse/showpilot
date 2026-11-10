import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { NotificationPreference } from "@showpilot/shared";
import {
  getPersonalNotificationPreferences,
  updatePersonalNotificationPreference,
} from "@/lib/personal-notifications";
import {
  notificationPreferenceCommandSchema,
  notificationPreferenceResultSchema,
  type NotificationPreferenceCommand,
} from "@/lib/notification-preference-contract";
import { withOperationTimeout } from "@/lib/operation-timeout";

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
) {
  const controller = new AbortController();
  try {
    return await withOperationTimeout(
      work(controller.signal),
      milliseconds,
      "The request timed out. Retry to confirm the saved choice.",
    );
  } finally {
    controller.abort();
  }
}

/** Both web editors share account/org reads and retain exact failed writes across closing/navigation. */
export function useNotificationPreferences(orgId: string, userId: string) {
  const client = useQueryClient();
  const queryKey = ["notification-preferences", orgId, userId];
  const mutationKey = ["notification-preference-change", orgId, userId];
  const query = useQuery({
    queryKey,
    retry: false,
    networkMode: "always",
    queryFn: () =>
      bounded(
        (signal) =>
          getPersonalNotificationPreferences({ data: { orgId }, signal }),
        8_000,
      ),
  });
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => {
      const command = notificationPreferenceCommandSchema.safeParse(
        entry.state.variables,
      );
      const result = notificationPreferenceResultSchema.safeParse(
        entry.state.data,
      );
      // Validation errors are new class instances on every parse. Keeping them
      // in the snapshot defeats Query's structural sharing and loops renders.
      return {
        status: entry.state.status,
        at: entry.state.submittedAt,
        error: entry.state.error,
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
      };
    },
  });
  const latest = history.at(-1);
  const unfinished =
    latest && (latest.status === "pending" || latest.status === "error")
      ? latest
      : null;
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    mutationFn: (command: NotificationPreferenceCommand) =>
      bounded(
        (signal) =>
          updatePersonalNotificationPreference({ data: command, signal }),
        10_000,
      ),
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<NotificationPreference[]>(queryKey, (current) =>
        current?.map((item) =>
          item.category === result.preference.category
            ? result.preference
            : item,
        ),
      );
      // A failed refresh remains a read error; it must never repeat the acknowledged write.
      void client.invalidateQueries({ queryKey, exact: true });
    },
    onSettled: () => {
      const cache = client.getMutationCache();
      for (const old of cache.findAll({ mutationKey, exact: true }))
        if (old.state.status !== "pending") cache.remove(old);
    },
  });
  const locked =
    !!unfinished || !query.data || query.isError || query.isFetching;
  return {
    query,
    unfinished,
    result: latest?.result ?? null,
    locked,
    change: (current: NotificationPreference) => {
      if (
        locked ||
        client
          .getMutationCache()
          .findAll({ mutationKey, exact: true })
          .some((entry) => entry.state.status === "pending")
      )
        return;
      mutation.mutate({
        orgId,
        category: current.category,
        deviceAlerts: !current.deviceAlerts,
        expectedDeviceAlerts: current.deviceAlerts,
        requestId: crypto.randomUUID(),
      });
    },
    retry: () => {
      if (unfinished?.status === "error" && unfinished.command)
        mutation.mutate(unfinished.command);
    },
  };
}
