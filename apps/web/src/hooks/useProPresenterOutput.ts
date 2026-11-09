import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  proPresenterOutputResultSchema,
  proPresenterOutputSnapshotSchema,
  type ProPresenterOutputCommand,
  type ProPresenterOutputResult,
  type ProPresenterOutputSnapshot,
} from "@showpilot/shared/propresenter-output";
import {
  getProPresenterOutput,
  changeProPresenterOutput,
} from "@/lib/propresenter-output";
import { runRouteLoad } from "@/lib/route-load-deadlines";

type Scope = { orgId: string; userId: string };
type Review = Scope & { enabled: boolean; expectedRevision: string | null };
type Attempt = { command: ProPresenterOutputCommand; at: number } & (
  | { kind: "pending" | "unknown" }
  | {
      kind: "confirmed";
      result: ProPresenterOutputResult;
      refresh: "idle" | "pending" | "failed" | "done";
    }
);

/** The receipt belongs to the actor and workspace, across Rundown and Settings.
 * Reads retain each surface's permission boundary. Unknown writes keep their
 * original ID, revision and deadline; refreshing a saved result only reads. */
export function useProPresenterOutput(
  options: Scope & { surface: "rundown" | "settings"; enabled: boolean },
) {
  const client = useQueryClient();
  const prefix = [
    "web-propresenter-output-state",
    options.userId,
    options.orgId,
  ];
  const queryKey = [...prefix, options.surface];
  const key = [
    "web-propresenter-output-command",
    options.userId,
    options.orgId,
  ];
  const hash = hashKey(key);
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const readAttempt = () => client.getQueryData<Attempt | null>(key) ?? null;
  const attempt = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    readAttempt,
    () => null,
  );
  const owner = useMemo(
    () => ({ active: false, refresh: null as AbortController | null }),
    [hash, options.surface, options.enabled],
  );
  const latest = useRef(owner);
  latest.current = owner;
  useEffect(() => {
    owner.active = options.enabled;
    return () => {
      owner.active = false;
      owner.refresh?.abort();
    };
  }, [owner, options.enabled]);
  const active = () => owner.active && latest.current === owner;
  const put = (before: Attempt | null, after: Attempt | null) =>
    client.setQueryData<Attempt | null>(key, (current) =>
      current === before ? after : current,
    );
  const read = (signal: AbortSignal) =>
    runRouteLoad(
      async (controller) =>
        proPresenterOutputSnapshotSchema.parse(
          await getProPresenterOutput({
            data: {
              orgId: options.orgId,
              userId: options.userId,
              surface: options.surface,
            },
            signal: controller.signal,
          }),
        ),
      signal,
      8_000,
    );
  const state = useQuery<ProPresenterOutputSnapshot>({
    queryKey,
    enabled: options.enabled,
    retry: false,
    networkMode: "always",
    refetchInterval: (query) =>
      options.enabled && query.state.status !== "error" ? 5_000 : false,
    queryFn: ({ signal }) => read(signal),
  });
  // Always subscribe to the error flag, including the first failed read.
  const readFailed = state.isError;
  const ready = () => {
    const current = readAttempt();
    return (
      active() &&
      (!current ||
        (current.kind === "confirmed" &&
          current.result.outcome === "applied" &&
          current.refresh === "done"))
    );
  };
  const canStart = options.enabled && !!state.data && !readFailed && ready();
  async function refresh() {
    const previous = readAttempt();
    if (
      !active() ||
      previous?.kind !== "confirmed" ||
      previous.refresh === "pending"
    )
      return;
    const controller = new AbortController();
    owner.refresh = controller;
    const claim = put(previous, { ...previous, refresh: "pending" });
    try {
      await client.cancelQueries({ queryKey: prefix });
      await client.fetchQuery({
        queryKey,
        staleTime: 0,
        retry: false,
        queryFn: () => read(controller.signal),
      });
      controller.signal.throwIfAborted();
      put(claim ?? null, { ...previous, refresh: "done" });
      void client.invalidateQueries({
        queryKey: prefix,
        predicate: (query) => query.queryKey.at(-1) !== options.surface,
      });
    } catch {
      put(claim ?? null, {
        ...previous,
        refresh: active() ? "failed" : "idle",
      });
    } finally {
      if (owner.refresh === controller) owner.refresh = null;
    }
  }
  async function execute(command: ProPresenterOutputCommand) {
    const previous = readAttempt();
    if (
      !active() ||
      previous?.kind === "pending" ||
      (previous?.kind === "confirmed" && previous.refresh !== "done")
    )
      return;
    const claim = put(previous, { kind: "pending", command, at: Date.now() });
    try {
      const result = await runRouteLoad(
        async (controller) =>
          proPresenterOutputResultSchema.parse(
            await changeProPresenterOutput({
              data: { ...command, surface: options.surface },
              signal: controller.signal,
            }),
          ),
        undefined,
        15_000,
      );
      if (
        result.orgId !== command.orgId ||
        result.userId !== command.userId ||
        result.requestId !== command.requestId ||
        result.enabled !== command.enabled ||
        result.expectedRevision !== command.expectedRevision ||
        result.expiresAt !== command.expiresAt
      )
        throw new Error("Reply belongs to another output change.");
      put(claim ?? null, {
        kind: "confirmed",
        command,
        result,
        refresh: "idle",
        at: Date.now(),
      });
      if (active()) await refresh();
    } catch {
      put(claim ?? null, { kind: "unknown", command, at: Date.now() });
    }
  }
  const matches = (review: Review) => {
    const current = client.getQueryData<ProPresenterOutputSnapshot>(queryKey);
    return (
      ready() &&
      !!current &&
      client.getQueryState(queryKey)?.status !== "error" &&
      review.orgId === options.orgId &&
      review.userId === options.userId &&
      review.expectedRevision === current.revision &&
      review.enabled !== current.enabled
    );
  };
  return {
    state,
    attempt,
    canStart,
    matches,
    prepare: (): Review | null =>
      canStart && state.data
        ? {
            orgId: options.orgId,
            userId: options.userId,
            enabled: !state.data.enabled,
            expectedRevision: state.data.revision,
          }
        : null,
    confirm(review: Review) {
      if (!matches(review)) return;
      const current = client.getQueryData<ProPresenterOutputSnapshot>(queryKey);
      if (!current) return;
      void execute({
        ...review,
        requestId: crypto.randomUUID(),
        expiresAt:
          current.serverTime +
          Math.max(
            0,
            Date.now() -
              (client.getQueryState(queryKey)?.dataUpdatedAt ?? Date.now()),
          ) +
          5_000,
      });
    },
    recover: () => {
      const current = readAttempt();
      if (current?.kind === "unknown") void execute(current.command);
    },
    refresh: () => void refresh(),
    dismiss: () => {
      const current = readAttempt();
      if (
        active() &&
        current?.kind === "confirmed" &&
        current.refresh === "done"
      )
        put(current, null);
    },
  };
}
