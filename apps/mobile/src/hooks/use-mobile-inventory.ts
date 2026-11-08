import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  inventoryCommandSchema,
  inventoryResultSchema,
  type InventoryCommand,
  type InventoryDraft,
  type InventoryResult,
} from "../lib/inventory-recovery";
import { runInventoryWork } from "../lib/inventory-recovery";
import { createLocalRequestUuid } from "../lib/request-id";

const emptyDraft: InventoryDraft = {
  name: "",
  description: "",
  location: "",
  defaultStartTime: "",
  sourceTemplateId: null,
};
type Attempt =
  | { kind: "saving" | "reviewing"; command: InventoryCommand; label: string }
  | {
      kind: "unconfirmed";
      command: InventoryCommand;
      label: string;
      message: string;
    }
  | {
      kind: "settled";
      command: InventoryCommand;
      label: string;
      result: InventoryResult;
      refresh: "idle" | "pending" | "failed";
      message?: string;
    };
type Work = {
  draft: InventoryDraft;
  attempt: Attempt | null;
  notice: string | null;
};

export function useMobileInventory(
  scope: { orgId: string; userId: string },
  onChanged: (signal: AbortSignal) => Promise<void>,
  send: (
    command: InventoryCommand,
    review: boolean,
    signal: AbortSignal,
  ) => Promise<InventoryResult>,
  enabled: boolean,
) {
  const client = useQueryClient();
  const key = ["mobile-show-inventory", scope.userId, scope.orgId],
    hash = hashKey(key);
  const initial = useMemo<Work>(
    () => ({ draft: emptyDraft, attempt: null, notice: null }),
    [hash],
  );
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<Work>(key);
  const work = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => read() ?? initial,
    () => read() ?? initial,
  );
  const owner = useMemo(
    () => ({ mounted: false, refresh: null as AbortController | null }),
    [hash, enabled],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  useEffect(() => {
    owner.mounted = enabled;
    return () => {
      owner.mounted = false;
      owner.refresh?.abort();
    };
  }, [owner, enabled]);
  const active = () => owner.mounted && currentOwner.current === owner;
  async function refresh() {
    const live = read();
    if (
      !active() ||
      live?.attempt?.kind !== "settled" ||
      live.attempt.refresh === "pending"
    )
      return;
    const attempt = live.attempt,
      controller = new AbortController();
    owner.refresh = controller;
    const claim = client.setQueryData<Work>(key, {
      ...live,
      attempt: { ...attempt, refresh: "pending", message: undefined },
    });
    try {
      await runInventoryWork(
        async (child) => {
          await onChanged(child.signal);
          if (child.signal.aborted)
            throw new Error("Inventory refresh cancelled.");
        },
        controller.signal,
        12000,
      );
      if (read() !== claim) return;
      const accepted =
        attempt.result.outcome === "applied" ||
        attempt.result.outcome === "superseded";
      client.setQueryData<Work>(key, {
        draft:
          accepted && attempt.command.operation.kind === "create"
            ? emptyDraft
            : live.draft,
        attempt: null,
        notice: accepted
          ? `${attempt.label}: confirmed. Inventory refreshed.`
          : "Inventory refreshed. Review the current details before trying again.",
      });
    } catch (error) {
      if (read() === claim)
        client.setQueryData<Work>(key, {
          ...live,
          attempt: {
            ...attempt,
            refresh: active() ? "failed" : "idle",
            message: active()
              ? message(error, "Could not refresh inventory.")
              : undefined,
          },
        });
    } finally {
      if (owner.refresh === controller) owner.refresh = null;
    }
  }
  async function execute(
    command: InventoryCommand,
    label: string,
    review = false,
  ) {
    const live = read();
    if (!live || (live.attempt && live.attempt.kind !== "unconfirmed")) return;
    const claim = client.setQueryData<Work>(key, {
      ...live,
      notice: null,
      attempt: { kind: review ? "reviewing" : "saving", command, label },
    });
    try {
      const result = await runInventoryWork(
        async (controller) => {
          if (controller.signal.aborted)
            throw new Error("Inventory request cancelled.");
          return inventoryResultSchema.parse(
            await send(command, review, controller.signal),
          );
        },
        undefined,
        15000,
      );
      const expectedId =
        command.operation.kind === "create"
          ? command.requestId
          : command.operation.id;
      if (result.requestId !== command.requestId || result.id !== expectedId)
        throw new Error(
          "The reply does not match this inventory request. Review the original request.",
        );
      if (read() !== claim) return;
      if (result.outcome === "cancelled") {
        client.setQueryData<Work>(key, {
          ...live,
          attempt: null,
          notice:
            "The original request is cancelled. Your draft is preserved; review it before trying again.",
        });
        return;
      }
      client.setQueryData<Work>(key, {
        ...live,
        notice: null,
        attempt: { kind: "settled", command, label, result, refresh: "idle" },
      });
      if (!review && result.outcome === "applied" && active()) await refresh();
    } catch (error) {
      if (read() === claim)
        client.setQueryData<Work>(key, {
          ...live,
          notice: null,
          attempt: {
            kind: "unconfirmed",
            command,
            label,
            message: message(
              error,
              "This inventory change could not be confirmed.",
            ),
          },
        });
    }
  }
  function submit(operation: InventoryCommand["operation"], label: string) {
    const live = read();
    if (!active() || !live || live.attempt) return;
    const parsed = inventoryCommandSchema.safeParse({
      ...scope,
      requestId: createLocalRequestUuid(),
      operation,
    });
    if (!parsed.success) {
      client.setQueryData<Work>(key, {
        ...live,
        notice: parsed.error.issues[0]?.message ?? "Check the show details.",
      });
      return;
    }
    void execute(parsed.data, label);
  }
  return {
    ...work,
    locked: !!work.attempt,
    setDraft: (update: (draft: InventoryDraft) => InventoryDraft) => {
      const live = read();
      if (active() && live && !live.attempt)
        client.setQueryData<Work>(key, {
          ...live,
          draft: update(live.draft),
          notice: null,
        });
    },
    create: () => {
      const live = read();
      if (live)
        submit(
          { ...live.draft, kind: "create" },
          `Add ${live.draft.name.trim()}`,
        );
    },
    archive: (
      item: { id: string; name: string; updatedAt: string },
      archived: boolean,
    ) =>
      submit(
        {
          kind: "archive",
          id: item.id,
          archived,
          expectedUpdatedAt: item.updatedAt,
        },
        `${archived ? "Archive" : "Restore"} ${item.name}`,
      ),
    retry: () => {
      const live = read();
      if (active() && live?.attempt?.kind === "unconfirmed")
        void execute(live.attempt.command, live.attempt.label);
    },
    review: () => {
      const live = read();
      if (active() && live?.attempt?.kind === "unconfirmed")
        void execute(live.attempt.command, live.attempt.label, true);
    },
    refresh: () => void refresh(),
  };
}
function message(error: unknown, fallback: string) {
  return error instanceof Error &&
    error.message !== "Inventory operation timed out."
    ? error.message
    : fallback;
}
