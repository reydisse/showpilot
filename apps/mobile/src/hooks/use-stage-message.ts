import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { decodeStageMessage, encodeStageMessage } from "@showpilot/shared";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  rundownChangeCommandSchema,
  rundownChangeReplySchema,
  type RundownChangeCommand,
  type RundownChangeReply,
} from "../lib/rundown-change-recovery";
type Scope = {
  orgId: string;
  userId: string;
  showId: string;
  serviceDate: string;
};
type Fields = { text: string; priority: boolean };
type Draft = Fields & { showId: string };
export type StageMessageReview = Scope & {
  revision: number;
  current: string;
} & (
    | { kind: "send"; fields: Fields }
    | { kind: "clear" }
    | { kind: "replace-draft" }
  );
const family = "mobile-stage-message-draft";
export function useStageMessage(
  scope: Scope,
  options: {
    active: boolean;
    ready: boolean;
    revision: number;
    message: string;
    send: (
      command: RundownChangeCommand,
      signal: AbortSignal,
    ) => Promise<RundownChangeReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = useMemo(
    () => [family, scope.userId, scope.orgId, scope.showId],
    [scope.userId, scope.orgId, scope.showId],
  );
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const draft =
    useRetainedDraftList<Draft | null>(family, scope).find(
      (d) => d?.showId === scope.showId,
    ) ?? null;
  const cached = () => client.getQueryData<Draft | null>(key);
  useEffect(() => {
    if (options.active && options.ready)
      client.setQueryData<Draft | null>(
        key,
        (current) =>
          current ?? {
            showId: scope.showId,
            ...decodeStageMessage(options.message),
          },
      );
  }, [
    client,
    key,
    scope.showId,
    options.active,
    options.ready,
    options.message,
  ]);
  const requests = useRetainedRequests(scope, {
    family: "mobile-stage-message-request",
    scopeKey: scope.showId,
    enabled: options.active,
    slot: () => "stage",
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
      "This stage message action could not be confirmed. It may have completed. Retry the original request to check its outcome.",
    refreshFailureMessage:
      "The action has a result, but the show could not refresh. Retry the refresh without sending the action again.",
    refresh: options.refresh,
  });
  const attempt = requests.work.stage;
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>([
      "mobile-stage-message-request",
      scope.userId,
      scope.orgId,
      scope.showId,
    ])?.stage;
  function setFields(fields: Partial<Fields>) {
    if (!requests.isActive() || currentAttempt()) return;
    client.setQueryData<Draft | null>(key, (current) =>
      current ? { ...current, ...fields } : current,
    );
  }
  function prepare(
    kind: StageMessageReview["kind"],
  ): StageMessageReview | null {
    const current = cached();
    if (!requests.isActive() || !options.ready || !current || currentAttempt())
      return null;
    const review = {
      ...scope,
      revision: options.revision,
      current: options.message,
    };
    if (kind === "send")
      return current.text.trim() && current.text.length <= 1980
        ? {
            ...review,
            kind,
            fields: { text: current.text, priority: current.priority },
          }
        : null;
    if (kind === "clear" && !options.message) return null;
    return { ...review, kind };
  }
  function canConfirm(review: StageMessageReview) {
    return (
      requests.isActive() &&
      options.ready &&
      !currentAttempt() &&
      review.orgId === scope.orgId &&
      review.userId === scope.userId &&
      review.showId === scope.showId &&
      review.serviceDate === scope.serviceDate &&
      review.revision === options.revision &&
      review.current === options.message
    );
  }
  function confirm(review: StageMessageReview) {
    if (!canConfirm(review)) return false;
    if (review.kind === "replace-draft") {
      client.setQueryData<Draft>(key, {
        showId: scope.showId,
        ...decodeStageMessage(review.current),
      });
      return true;
    }
    const parsed = rundownChangeCommandSchema.safeParse({
      ...scope,
      requestId: createLocalRequestUuid(),
      expectedRevision: review.revision,
      ...(review.kind === "send"
        ? {
            action: "stage-message",
            message: encodeStageMessage(
              review.fields.text,
              review.fields.priority,
            ),
          }
        : { action: "stage-clear" }),
    });
    if (!parsed.success) return false;
    requests.start(
      parsed.data,
      review.kind === "send" ? "Send stage message" : "Clear stage message",
    );
    return true;
  }
  return {
    draft,
    attempt,
    setFields,
    prepare,
    canConfirm,
    confirm,
    retry: () => {
      if (options.ready) requests.retry("stage");
    },
    refresh: () => {
      if (options.ready) requests.refresh("stage");
    },
    dismiss: () => requests.dismiss("stage"),
  };
}
