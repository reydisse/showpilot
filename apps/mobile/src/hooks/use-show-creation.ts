import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  creationCommand,
  showCreationReplySchema,
  type ShowCreationCommand,
  type ShowCreationDraft,
  type ShowCreationReply,
} from "../lib/show-creation-recovery";

export function useShowCreationDrafts(scope: {
  orgId: string;
  userId: string;
}) {
  return useRetainedDraftList<ShowCreationDraft>(
    "mobile-show-creation-draft",
    scope,
  );
}
/** One outstanding creation per account/workspace, reachable from all three
 * entry points. Closing a sheet never authorizes another create request. */
export function useShowCreation(
  scope: { orgId: string; userId: string },
  initial: ShowCreationDraft,
  options: {
    active: boolean;
    send: (
      command: ShowCreationCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<ShowCreationReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = ["mobile-show-creation-draft", scope.userId, scope.orgId];
  const requestKey = [
    "mobile-show-creation-request",
    scope.userId,
    scope.orgId,
  ];
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const drafts = useShowCreationDrafts(scope);
  const draft = drafts[0] ?? initial;
  async function send(
    command: ShowCreationCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const reply = showCreationReplySchema.parse(
      await options.send(command, review, signal),
    );
    if (
      reply.result.kind === "created" &&
      (reply.result.result.showId !== command.requestId ||
        reply.result.result.serviceDate !== command.serviceDate)
    )
      throw new Error("Reply does not match the show you requested.");
    return reply;
  }
  const requests = useRetainedRequests(scope, {
    family: "mobile-show-creation-request",
    enabled: options.active,
    slot: () => "create",
    send: (command: ShowCreationCommand, signal) =>
      send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => showCreationReplySchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "Creation could not be confirmed. Retry the original request or review it before changing the draft.",
    refresh: options.refresh,
  });
  const currentAttempt = () =>
    client.getQueryData<typeof requests.work>(requestKey)?.create;
  function setDraft(update: (value: ShowCreationDraft) => ShowCreationDraft) {
    if (!requests.isActive() || currentAttempt()) return;
    client.setQueryData<ShowCreationDraft>(key, (value) =>
      value ? update(value) : value,
    );
  }
  function submit() {
    if (!requests.isActive() || currentAttempt()) return;
    const current = client.getQueryData<ShowCreationDraft>(key);
    if (!current) return;
    const command = creationCommand(scope, createLocalRequestUuid(), current);
    if (command.success)
      requests.start(
        command.data,
        `${current.name || "Untitled show"} (${current.serviceDate})`,
      );
  }
  function finish() {
    const attempt = currentAttempt();
    if (
      !requests.isActive() ||
      attempt?.kind !== "confirmed" ||
      attempt.refresh !== "done"
    )
      return false;
    requests.dismiss("create");
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  function discard() {
    if (!requests.isActive() || currentAttempt()) return false;
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  function editUnapplied() {
    const attempt = currentAttempt();
    if (
      !requests.isActive() ||
      attempt?.kind !== "confirmed" ||
      attempt.refresh !== "done" ||
      attempt.result.result.kind !== "cancelled"
    )
      return;
    requests.dismiss("create");
  }
  return {
    draft,
    attempt: requests.work.create,
    locked: !!requests.work.create,
    setDraft,
    submit,
    finish,
    discard,
    editUnapplied,
    retry: () => requests.retry("create"),
    reviewOriginal: () => requests.review("create"),
    refresh: () => requests.refresh("create"),
  };
}
