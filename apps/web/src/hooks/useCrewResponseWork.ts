import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  crewResponseCommandSchema,
  crewResponseResultSchema,
  type CrewResponseCommand,
  type CrewResponseResult,
} from "@/lib/crew-response-contract";
import type { getCrewSchedulePortal } from "@/lib/crew-schedule";
export type CrewPortalAssignment = Awaited<
  ReturnType<typeof getCrewSchedulePortal>
>["assignments"][number];
type Attempt = { command: CrewResponseCommand } & (
  | { kind: "pending" }
  | { kind: "unknown"; message: string }
  | {
      kind: "confirmed";
      result: CrewResponseResult;
      refresh: "idle" | "pending" | "failed" | "done";
      message?: string;
    }
);
export type CrewResponseEntry = {
  selection: CrewPortalAssignment;
  reason: string;
  declining: boolean;
  validationError?: string;
  attempt?: Attempt;
};
type Work = Record<string, CrewResponseEntry>;
export function useCrewResponseWork(
  token: string,
  options: {
    send: (
      command: CrewResponseCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<unknown>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient(),
    key = ["crew-portal-response", token],
    hash = hashKey(key);
  const initial = useMemo<Work>(() => ({}), [hash]);
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<Work>(key) ?? initial;
  const entries = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    read,
    read,
  );
  const owner = useMemo(
    () => ({ mounted: false, refreshes: new Map<string, AbortController>() }),
    [hash],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      for (const controller of owner.refreshes.values()) controller.abort();
    };
  }, [owner]);
  const active = () => owner.mounted && currentOwner.current === owner;
  const put = (
    id: string,
    expected: CrewResponseEntry | undefined,
    next: CrewResponseEntry,
  ) =>
    client.setQueryData<Work>(key, (current) =>
      current && current[id] === expected
        ? { ...current, [id]: next }
        : current,
    )?.[id];
  function remove(id: string, expected: CrewResponseEntry) {
    client.setQueryData<Work>(key, (current) => {
      if (!current || current[id] !== expected) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }
  async function refresh(id: string) {
    const original = read()[id],
      attempt = original?.attempt;
    if (
      !active() ||
      attempt?.kind !== "confirmed" ||
      attempt.refresh === "pending"
    )
      return;
    const controller = new AbortController();
    owner.refreshes.set(id, controller);
    const pending = put(id, original, {
      ...original,
      attempt: { ...attempt, refresh: "pending", message: undefined },
    });
    try {
      await runRouteLoad(
        async (child) => {
          await options.refresh(child.signal);
          child.signal.throwIfAborted();
        },
        controller.signal,
        12000,
      );
      put(id, pending, {
        ...original,
        attempt: { ...attempt, refresh: "done", message: undefined },
      });
    } catch (error) {
      put(id, pending, {
        ...original,
        attempt: {
          ...attempt,
          refresh: active() ? "failed" : "idle",
          message: active()
            ? message(error, "The page could not refresh.")
            : undefined,
        },
      });
    } finally {
      if (owner.refreshes.get(id) === controller) owner.refreshes.delete(id);
    }
  }
  async function execute(
    id: string,
    command: CrewResponseCommand,
    review: boolean,
  ) {
    const original = read()[id];
    if (
      !active() ||
      !original ||
      command.token !== token ||
      original.attempt?.kind === "pending" ||
      original.attempt?.kind === "confirmed"
    )
      return;
    const pending = put(id, original, {
      ...original,
      validationError: undefined,
      attempt: { kind: "pending", command },
    });
    try {
      const result = await runRouteLoad(
        async (controller) =>
          crewResponseResultSchema.parse(
            await options.send(command, review, controller.signal),
          ),
        undefined,
        15000,
      );
      if (
        result.assignmentId !== command.assignmentId ||
        result.requestId !== command.requestId
      )
        throw new Error("The reply does not match your original response.");
      const next = put(id, pending, {
        ...original,
        attempt: { kind: "confirmed", command, result, refresh: "idle" },
      });
      if (active() && next === read()[id]) await refresh(id);
    } catch (error) {
      put(id, pending, {
        ...original,
        attempt: {
          kind: "unknown",
          command,
          message: message(error, "Your response could not be confirmed."),
        },
      });
    }
  }
  function draft(selection: CrewPortalAssignment, declining = false) {
    const current = read()[selection.id];
    return (
      current ??
      put(selection.id, undefined, { selection, reason: "", declining })
    );
  }
  function submit(
    selection: CrewPortalAssignment,
    response: "confirmed" | "declined",
  ) {
    if (!active()) return;
    const current = draft(selection, response === "declined");
    if (!current || current.attempt) return;
    const parsed = crewResponseCommandSchema.safeParse({
      token,
      assignmentId: selection.id,
      requestId: crypto.randomUUID(),
      expectedRevision: current.selection.revision,
      reviewedVersion: current.selection.responseVersion,
      response,
      reason: response === "declined" ? current.reason : "",
    });
    if (parsed.success) void execute(selection.id, parsed.data, false);
    else
      put(selection.id, current, {
        ...current,
        validationError:
          "Your response could not be sent. Keep the note within 500 characters and reopen the invitation if its assignment details are incomplete.",
      });
  }
  return {
    entries,
    decline: (selection: CrewPortalAssignment) => {
      if (!active()) return;
      const current = draft(selection, true);
      if (current && !current.attempt)
        put(selection.id, current, { ...current, declining: true });
    },
    setReason: (id: string, reason: string) => {
      const current = read()[id];
      if (active() && current && !current.attempt)
        put(id, current, { ...current, reason, validationError: undefined });
    },
    back: (id: string) => {
      const current = read()[id];
      if (active() && current && !current.attempt)
        put(id, current, { ...current, declining: false });
    },
    submit,
    retry: (id: string) => {
      const attempt = read()[id]?.attempt;
      if (attempt?.kind === "unknown") void execute(id, attempt.command, false);
    },
    review: (id: string) => {
      const attempt = read()[id]?.attempt;
      if (attempt?.kind === "unknown") void execute(id, attempt.command, true);
    },
    refresh: (id: string) => void refresh(id),
    editCancelled: (id: string) => {
      const current = read()[id],
        attempt = current?.attempt;
      if (
        active() &&
        attempt?.kind === "confirmed" &&
        attempt.refresh === "done" &&
        attempt.result.outcome === "cancelled"
      )
        put(id, current, { ...current, attempt: undefined });
    },
    useCurrent: (selection: CrewPortalAssignment) => {
      const current = read()[selection.id],
        attempt = current?.attempt;
      if (
        active() &&
        current &&
        (!attempt ||
          (attempt.kind === "confirmed" && attempt.refresh === "done"))
      )
        put(selection.id, current, {
          ...current,
          selection,
          attempt: undefined,
        });
    },
    discard: (id: string) => {
      const current = read()[id],
        attempt = current?.attempt;
      if (
        active() &&
        current &&
        (!attempt ||
          (attempt.kind === "confirmed" && attempt.refresh === "done"))
      )
        remove(id, current);
    },
  };
}
function message(error: unknown, fallback: string) {
  return error instanceof Error
    ? error.message === "Page loading timed out."
      ? "The request timed out."
      : error.message
    : fallback;
}
