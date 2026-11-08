import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createShowInputSchema,
  showCreationResultSchema,
  showCreationReviewSchema,
  type CreateServiceForOrgInput,
  type ShowCreationResult,
} from "@/lib/show-creation-contract";
import { runRouteLoad } from "@/lib/route-load-deadlines";

type Command = CreateServiceForOrgInput & { requestId: string; userId: string };
type Attempt =
  | { kind: "creating" | "reviewing"; command: Command }
  | { kind: "unconfirmed"; command: Command; message: string }
  | {
      kind: "created";
      command: Command;
      result: ShowCreationResult;
      opening: "idle" | "pending" | "failed";
      message?: string;
    };
type Work<D> = { draft: D; attempt: Attempt | null; notice: string | null };
export type ShowCreationScope = {
  orgId: string;
  userId: string;
  entry: string;
};
export type OpenCreatedShow = (
  result: ShowCreationResult,
  signal: AbortSignal,
) => Promise<void>;

/** A creation and its exact retry outlive the form, but belong to one account,
 * organization and entry point. Navigation completion is a separate operation. */
export function useShowCreation<D>(
  scope: ShowCreationScope,
  initialDraft: D,
  options: {
    onCreated: OpenCreatedShow;
    beforeCreate?: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = ["show-creation", scope.userId, scope.orgId, scope.entry],
    hash = hashKey(key);
  // Defaults seed a scope once; refreshed source lists must not replace a draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo<Work<D>>(
    () => ({ draft: initialDraft, attempt: null, notice: null }),
    [hash],
  );
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<Work<D>>(key);
  const work = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => client.getQueryData<Work<D>>(key) ?? initial,
    () => client.getQueryData<Work<D>>(key) ?? initial,
  );
  const owner = useMemo(
    () => ({ mounted: false, opening: null as AbortController | null }),
    [hash],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.opening?.abort();
    };
  }, [owner]);
  const active = () => owner.mounted && currentOwner.current === owner;
  async function open() {
    const live = read();
    if (
      !active() ||
      !live ||
      live.attempt?.kind !== "created" ||
      live.attempt.opening === "pending"
    )
      return;
    const attempt = live.attempt,
      controller = new AbortController();
    owner.opening = controller;
    const claim = client.setQueryData<Work<D>>(key, {
      ...live,
      attempt: { ...attempt, opening: "pending", message: undefined },
    });
    try {
      await runRouteLoad(
        async (child) => {
          await options.onCreated(attempt.result, child.signal);
          child.signal.throwIfAborted();
        },
        controller.signal,
        12000,
      );
      if (read() === claim) client.setQueryData<Work<D>>(key, initial);
    } catch (error) {
      if (read() === claim)
        client.setQueryData<Work<D>>(key, {
          ...live,
          attempt: {
            ...attempt,
            opening: active() ? "failed" : "idle",
            message: active()
              ? error instanceof Error
                ? error.message
                : "Could not open the created show."
              : undefined,
          },
        });
    } finally {
      if (owner.opening === controller) owner.opening = null;
    }
  }
  async function execute(command: Command) {
    const live = read();
    if (!live || (live.attempt && live.attempt.kind !== "unconfirmed")) return;
    const uncertain = live.attempt !== null;
    const claim = client.setQueryData<Work<D>>(key, {
      ...live,
      notice: null,
      attempt: { kind: "creating", command },
    });
    let issued = false;
    try {
      const result = await runRouteLoad(
        async (controller) => {
          await options.beforeCreate?.(controller.signal);
          controller.signal.throwIfAborted();
          const { createNextService } = await import("@/lib/pm-actions");
          controller.signal.throwIfAborted();
          issued = true;
          return showCreationResultSchema.parse(
            await createNextService({
              data: command,
              signal: controller.signal,
            }),
          );
        },
        undefined,
        15000,
      );
      if (
        result.showId !== command.requestId ||
        result.serviceDate !== command.serviceDate
      )
        throw new Error(
          "The returned show does not match this request. Review the original request before continuing.",
        );
      if (read() !== claim) return;
      client.setQueryData<Work<D>>(key, {
        ...live,
        notice: null,
        attempt: { kind: "created", command, result, opening: "idle" },
      });
      if (active()) await open();
    } catch (error) {
      if (read() !== claim) return;
      const message =
        error instanceof Error
          ? error.message
          : "Show creation could not be confirmed.";
      client.setQueryData<Work<D>>(key, {
        ...live,
        notice: issued || uncertain ? null : message,
        attempt:
          issued || uncertain
            ? { kind: "unconfirmed", command, message }
            : null,
      });
    }
  }
  async function review() {
    const live = read();
    if (!live || live.attempt?.kind !== "unconfirmed") return;
    const attempt = live.attempt;
    const claim = client.setQueryData<Work<D>>(key, {
      ...live,
      attempt: { kind: "reviewing", command: attempt.command },
    });
    try {
      const result = await runRouteLoad(
        async (controller) => {
          const { reviewShowCreation } =
            await import("@/lib/show-creation-review");
          controller.signal.throwIfAborted();
          return showCreationReviewSchema.parse(
            await reviewShowCreation({
              data: attempt.command,
              signal: controller.signal,
            }),
          );
        },
        undefined,
        15000,
      );
      if (read() !== claim) return;
      if (result.kind === "created") {
        if (
          result.result.showId !== attempt.command.requestId ||
          result.result.serviceDate !== attempt.command.serviceDate
        )
          throw new Error("The reviewed show does not match this request.");
        client.setQueryData<Work<D>>(key, {
          ...live,
          notice: "The original request already created this show.",
          attempt: {
            kind: "created",
            command: attempt.command,
            result: result.result,
            opening: "idle",
          },
        });
      } else
        client.setQueryData<Work<D>>(key, {
          ...live,
          attempt: null,
          notice:
            result.kind === "removed"
              ? "The original show was removed. Review the details before creating another."
              : "The original request is cancelled. Review the details before creating the show.",
        });
    } catch (error) {
      if (read() === claim)
        client.setQueryData<Work<D>>(key, {
          ...live,
          attempt: {
            ...attempt,
            message:
              error instanceof Error
                ? error.message
                : "The request review did not finish. Retry the review before editing.",
          },
        });
    }
  }
  return {
    draft: work.draft,
    attempt: work.attempt,
    notice: work.notice,
    locked: !!work.attempt,
    pending:
      work.attempt?.kind === "creating" ||
      work.attempt?.kind === "reviewing" ||
      (work.attempt?.kind === "created" && work.attempt.opening === "pending"),
    setDraft: (update: (draft: D) => D) => {
      const live = read();
      if (live && !live.attempt)
        client.setQueryData<Work<D>>(key, {
          ...live,
          draft: update(live.draft),
          notice: null,
        });
    },
    submit: (input: CreateServiceForOrgInput) => {
      const live = read();
      if (!live || live.attempt) return;
      const parsed = createShowInputSchema.safeParse({
        ...input,
        orgId: scope.orgId,
        userId: scope.userId,
        requestId: crypto.randomUUID(),
      });
      if (!parsed.success) {
        client.setQueryData<Work<D>>(key, {
          ...live,
          notice: parsed.error.issues[0]?.message ?? "Check the show details.",
        });
        return;
      }
      void execute({
        ...parsed.data,
        userId: scope.userId,
        requestId: parsed.data.requestId!,
      });
    },
    retry: () => {
      const live = read();
      if (live?.attempt?.kind === "unconfirmed")
        void execute(live.attempt.command);
    },
    another: () => {
      const live = read();
      if (
        live?.attempt?.kind === "created" &&
        live.attempt.opening !== "pending"
      )
        client.setQueryData<Work<D>>(key, initial);
    },
    review: () => void review(),
    open: () => void open(),
  };
}
export type ShowCreationWork<D> = ReturnType<typeof useShowCreation<D>>;
