import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import {
  createLocalRequestId,
  createLocalRequestUuid,
} from "../lib/request-id";
import {
  itemDraftFields,
  parseRundownDuration,
  type RundownItemDraft,
} from "../lib/rundown-item-draft";
import {
  rundownChangeCommandSchema,
  rundownChangeReplySchema,
  type RundownChangeCommand,
  type RundownChangeReply,
} from "../lib/rundown-change-recovery";
import type { RundownItem } from "../lib/mobile-api";
const family = "mobile-rundown-item-draft";
export function useRundownItemEditor(
  scope: { orgId: string; userId: string; showId: string; serviceDate: string },
  options: {
    active: boolean;
    canSubmit: boolean;
    revision: number;
    items: RundownItem[];
    send: (
      command: RundownChangeCommand,
      signal: AbortSignal,
    ) => Promise<RundownChangeReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = [family, scope.userId, scope.orgId, scope.showId];
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const draft =
    useRetainedDraftList<RundownItemDraft | null>(family, scope).find(
      (d) => d?.showId === scope.showId,
    ) ?? null;
  const cached = () => client.getQueryData<RundownItemDraft | null>(key);
  const requests = useRetainedRequests(scope, {
    family: "mobile-rundown-item-request",
    scopeKey: scope.showId,
    enabled: options.active,
    slot: () => "edit",
    send: async (command: RundownChangeCommand, signal) => {
      const result = rundownChangeReplySchema.parse(
        await options.send(command, signal),
      );
      if (result.showId !== command.showId)
        throw new Error("The reply belongs to another show.");
      return result;
    },
    parseResult: (value) => rundownChangeReplySchema.parse(value),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "This edit could not be confirmed. It may have completed. Retry the original request to check its outcome.",
    refreshFailureMessage:
      "The edit has a result, but the rundown could not refresh. Retry the refresh without sending the edit again.",
    refresh: options.refresh,
  });
  const attempt = requests.work.edit;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>([
      "mobile-rundown-item-request",
      scope.userId,
      scope.orgId,
      scope.showId,
    ])?.edit;
  function open(item: RundownItem | null) {
    if (
      !requests.isActive() ||
      cached() ||
      currentAttempt() ||
      !options.canSubmit
    )
      return;
    client.setQueryData<RundownItemDraft>(key, {
      id: item?.id ?? createLocalRequestId("rundown-item"),
      showId: scope.showId,
      base: {
        item,
        revision: options.revision,
        order: options.items.map((i) => i.id),
        serviceDate: scope.serviceDate,
      },
      fields: itemDraftFields(item),
    });
  }
  function setFields(fields: Partial<RundownItemDraft["fields"]>) {
    if (!requests.isActive() || currentAttempt()) return;
    client.setQueryData<RundownItemDraft | null>(key, (current) =>
      current
        ? { ...current, fields: { ...current.fields, ...fields } }
        : current,
    );
  }
  function submit(direction?: "up" | "down") {
    const current = cached();
    if (
      !requests.isActive() ||
      !options.canSubmit ||
      !current ||
      currentAttempt() ||
      current.base.serviceDate !== scope.serviceDate ||
      current.base.revision !== options.revision
    )
      return;
    const identity = {
      ...scope,
      expectedRevision: current.base.revision,
      requestId: createLocalRequestUuid(),
    };
    let command: unknown;
    if (direction) {
      if (!current.base.item) return;
      const order = [...current.base.order],
        index = order.indexOf(current.id),
        next = index + (direction === "up" ? -1 : 1);
      if (index < 0 || next < 0 || next >= order.length) return;
      [order[index], order[next]] = [order[next], order[index]];
      command = { ...identity, action: "reorder", order };
    } else {
      command = {
        ...identity,
        action: current.base.item ? "update-item" : "add-item",
        itemId: current.id,
        fields: {
          ...current.fields,
          title: current.fields.title.trim(),
          assignee: current.fields.assignee.trim(),
          cue: current.fields.cue.trim(),
          notes: current.fields.notes.trim(),
          duration:
            current.fields.type === "header"
              ? 0
              : parseRundownDuration(current.fields.duration),
        },
      };
    }
    const parsed = rundownChangeCommandSchema.safeParse(command);
    if (parsed.success)
      requests.start(
        parsed.data,
        direction ? "Move item" : current.base.item ? "Save item" : "Add item",
      );
  }
  function settled() {
    const original = currentAttempt();
    return (
      !original ||
      (original.kind === "confirmed" && original.refresh === "done")
    );
  }
  function discard() {
    if (!requests.isActive() || !settled()) return false;
    if (currentAttempt()) requests.dismiss("edit");
    client.setQueryData(key, null);
    return true;
  }
  // Explicit review keeps the operator's fields while rebasing only the revision
  // and item identity they have just seen. Never silently rebase an uncertain save.
  function review() {
    const current = cached(),
      original = currentAttempt();
    if (!requests.isActive() || !options.canSubmit || !current || !settled())
      return;
    if (
      original?.kind === "confirmed" &&
      original.result.revision !== null &&
      options.revision < original.result.revision
    )
      return;
    const item = options.items.find((i) => i.id === current.id) ?? null;
    if (current.base.item && !item) return;
    if (original) requests.dismiss("edit");
    client.setQueryData<RundownItemDraft>(key, {
      ...current,
      base: {
        item,
        revision: options.revision,
        order: options.items.map((i) => i.id),
        serviceDate: scope.serviceDate,
      },
    });
  }
  return {
    draft,
    attempt,
    open,
    setFields,
    submit,
    review,
    discard,
    retry: () => {
      if (options.canSubmit) requests.retry("edit");
    },
    refresh: () => {
      if (options.canSubmit) requests.refresh("edit");
    },
  };
}
