import { useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  personalResponseCommandSchema,
  personalResponseResultSchema,
  type PersonalResponseCommand,
  type PersonalResponseResult,
  type ResponseDraft,
  type ResponseSelection,
} from "../lib/personal-response-recovery";
const family = "mobile-personal-response-draft";
export function usePersonalResponses(
  scope: { orgId: string; userId: string },
  options: {
    enabled: boolean;
    send: (
      command: PersonalResponseCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<PersonalResponseResult>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = (id: string) => [family, scope.userId, scope.orgId, id];
  const drafts = useRetainedDraftList<ResponseDraft>(family, scope);
  const read = (id: string) => client.getQueryData<ResponseDraft>(key(id));
  async function send(
    command: PersonalResponseCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const reply = personalResponseResultSchema.parse(
      await options.send(command, review, signal),
    );
    if (reply.assignmentId !== command.assignmentId)
      throw new Error("The reply does not match your assignment.");
    return reply;
  }
  const requests = useRetainedRequests(scope, {
    family: "mobile-personal-response-request",
    enabled: options.enabled,
    slot: (command: PersonalResponseCommand) => command.assignmentId,
    send: (command, signal) => send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => personalResponseResultSchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    refresh: options.refresh,
    failureMessage:
      "Your response could not be confirmed. Keep this request and retry or review it.",
  });
  const attempt = (id: string) =>
    client.getQueryData<typeof requests.work>([
      "mobile-personal-response-request",
      scope.userId,
      scope.orgId,
    ])?.[id];
  function put(draft: ResponseDraft) {
    client.setQueryDefaults(key(draft.assignmentId), { gcTime: Infinity });
    client.setQueryData(key(draft.assignmentId), draft);
  }
  function decline(selection: ResponseSelection) {
    if (
      !requests.isActive() ||
      attempt(selection.assignmentId) ||
      read(selection.assignmentId)
    )
      return;
    put({ ...selection, reason: "" });
  }
  function submit(
    selection: ResponseSelection,
    response: "confirmed" | "declined",
    reason: string,
  ) {
    if (!requests.isActive() || attempt(selection.assignmentId)) return;
    const command = personalResponseCommandSchema.safeParse({
      ...scope,
      ...selection,
      requestId: createLocalRequestUuid(),
      response,
      reason,
    });
    if (command.success) requests.start(command.data, selection.label);
  }
  function settled(id: string) {
    const current = attempt(id);
    return (
      requests.isActive() &&
      current?.kind === "confirmed" &&
      current.refresh === "done"
    );
  }
  return {
    work: requests.work,
    drafts,
    active: options.enabled,
    blocked: (id: string) => !!attempt(id) || !!read(id),
    decline,
    accept: (selection: ResponseSelection) => {
      if (!read(selection.assignmentId)) submit(selection, "confirmed", "");
    },
    setReason: (id: string, reason: string) => {
      if (!requests.isActive() || attempt(id)) return;
      const draft = read(id);
      if (draft) put({ ...draft, reason });
    },
    submitDecline: (id: string) => {
      const draft = read(id);
      if (draft) submit(draft, "declined", draft.reason);
    },
    discard: (id: string) => {
      if (requests.isActive() && !attempt(id))
        client.removeQueries({ queryKey: key(id), exact: true });
    },
    retry: requests.retry,
    review: requests.review,
    refresh: requests.refresh,
    finish: (id: string) => {
      if (!settled(id)) return;
      requests.dismiss(id);
      client.removeQueries({ queryKey: key(id), exact: true });
    },
    editCancelled: (id: string) => {
      const current = attempt(id);
      if (
        settled(id) &&
        current?.kind === "confirmed" &&
        current.result.outcome === "cancelled"
      )
        requests.dismiss(id);
    },
    reviewLatest: (selection: ResponseSelection) => {
      const id = selection.assignmentId,
        draft = read(id);
      if (!settled(id) || !draft) return;
      requests.dismiss(id);
      put({ ...selection, reason: draft.reason });
    },
  };
}
