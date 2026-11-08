import { useCallback, useMemo } from "react";
import { getServiceAssignments } from "@/lib/schedule";
import { useOperatorRead } from "./useOperatorRead";

type Assignment = Awaited<ReturnType<typeof getServiceAssignments>>[number];
export function useScheduleRoster({
  orgId,
  userId,
  showId,
  assignments,
}: {
  orgId: string;
  userId: string;
  showId: string | undefined;
  assignments: Assignment[];
}) {
  const initialValue = useMemo(
    () => assignments.filter((row) => row.showId === showId),
    [assignments, showId],
  );
  // A newly confirmed loader snapshot retires any older in-flight roster read.
  // Equal loader snapshots keep the polling lifecycle stable.
  const key = JSON.stringify([userId, orgId, showId, initialValue]);
  const read = useCallback(
    (signal: AbortSignal) =>
      showId
        ? getServiceAssignments({ data: { orgId, showId }, signal })
        : Promise.resolve([]),
    [orgId, showId],
  );
  return useOperatorRead({
    key,
    initialValue,
    read,
    enabled: Boolean(showId),
    intervalMs: 15_000,
    errorMessage:
      "Roster refresh failed. Showing the last confirmed crew list. Responses may have changed.",
  });
}
