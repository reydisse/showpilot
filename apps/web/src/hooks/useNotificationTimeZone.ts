import { useEffect } from "react";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getPersonalNotificationTimeZone,
  savePersonalNotificationTimeZone,
} from "@/lib/personal-notifications";
import {
  notificationTimeZoneCommandSchema,
  notificationTimeZoneResultSchema,
  notificationTimeZoneStateSchema,
  type NotificationTimeZoneCommand,
} from "@/lib/notification-timezone-contract";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import { getDeviceTimeZone, useDeviceTimeZone } from "./useDeviceTimeZone";

/** The background sync and account details share the same retained command. */
export function useNotificationTimeZone(
  orgId: string,
  userId: string,
  automatic: boolean,
) {
  const client = useQueryClient();
  const deviceZone = useDeviceTimeZone();
  const queryKey = ["notification-timezone", orgId, userId];
  const mutationKey = ["notification-timezone-write", orgId, userId];
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => {
      const command = notificationTimeZoneCommandSchema.safeParse(
        entry.state.variables,
      );
      const result = notificationTimeZoneResultSchema.safeParse(
        entry.state.data,
      );
      return {
        status: entry.state.status,
        at: entry.state.submittedAt,
        command: command.success ? command.data : null,
        result: result.success ? result.data : null,
      };
    },
  });
  const latest = history.at(-1);
  const unfinished =
    latest?.status === "pending" || latest?.status === "error" ? latest : null;
  const query = useQuery({
    queryKey,
    retry: false,
    networkMode: "always",
    refetchOnMount: false,
    enabled: unfinished?.status !== "pending",
    queryFn: async ({ signal }) =>
      notificationTimeZoneStateSchema.parse(
        await runRouteLoad(
          (controller) =>
            getPersonalNotificationTimeZone({
              data: { orgId },
              signal: controller.signal,
            }),
          signal,
          8_000,
        ),
      ),
  });
  const mutation = useMutation({
    mutationKey,
    retry: false,
    networkMode: "always",
    gcTime: Infinity,
    onMutate: () => client.cancelQueries({ queryKey, exact: true }),
    mutationFn: async (command: NotificationTimeZoneCommand) => {
      const result = notificationTimeZoneResultSchema.parse(
        await runRouteLoad(
          (controller) =>
            savePersonalNotificationTimeZone({
              data: command,
              signal: controller.signal,
            }),
          undefined,
          8_000,
        ),
      );
      if (result.requestId !== command.requestId)
        throw new Error("Timezone acknowledgement did not match the save.");
      return result;
    },
    onSuccess: async (result) => {
      await client.cancelQueries({ queryKey, exact: true });
      client.setQueryData<
        ReturnType<typeof notificationTimeZoneStateSchema.parse>
      >(queryKey, (current) =>
        current && current.revision > result.state.revision
          ? current
          : result.state,
      );
      void client.invalidateQueries({ queryKey, exact: true });
    },
    onSettled: () => {
      const cache = client.getMutationCache(),
        entries = cache.findAll({ mutationKey, exact: true });
      for (const old of entries)
        if (old !== entries.at(-1) && old.state.status !== "pending")
          cache.remove(old);
    },
  });
  const readFailed =
    query.isError ||
    (query.isFetching && query.errorUpdatedAt > query.dataUpdatedAt);
  const pendingInCache = () =>
    client
      .getMutationCache()
      .findAll({ mutationKey, exact: true })
      .some((entry) => entry.state.status === "pending");
  const change = () => {
    if (
      unfinished ||
      !query.data ||
      readFailed ||
      query.isFetching ||
      pendingInCache()
    )
      return;
    mutation.mutate({
      orgId,
      requestId: crypto.randomUUID(),
      expectedRevision: query.data.revision,
      timeZone: getDeviceTimeZone(),
    });
  };
  const { mutate } = mutation;
  useEffect(() => {
    if (
      !automatic ||
      unfinished ||
      readFailed ||
      query.isFetching ||
      !query.data ||
      pendingInCache()
    )
      return;
    // Read the actual device zone inside the effect: the SSR snapshot is UTC.
    const timeZone = getDeviceTimeZone();
    if (query.data.timeZone === timeZone) return;
    // A retry must not immediately undo the newer setting it just discovered.
    if (
      latest?.result &&
      latest.result.outcome !== "applied" &&
      latest.command?.timeZone === timeZone
    )
      return;
    mutate({
      orgId,
      requestId: crypto.randomUUID(),
      expectedRevision: query.data.revision,
      timeZone,
    });
  }, [
    automatic,
    orgId,
    userId,
    deviceZone,
    query.data,
    query.isFetching,
    readFailed,
    unfinished,
    latest,
    mutate,
    client,
  ]);
  return {
    query,
    readFailed,
    unfinished,
    result: latest?.result,
    deviceZone,
    change,
    retry: () => {
      if (
        unfinished?.status === "error" &&
        unfinished.command &&
        !pendingInCache()
      )
        mutation.mutate(unfinished.command);
    },
  };
}
