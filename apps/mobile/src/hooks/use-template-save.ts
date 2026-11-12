import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedDraftList,
  useRetainedRequests,
} from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  templateCopySchema,
  templateSizeError,
  templateSaveCommandSchema,
  templateSaveReplySchema,
  type TemplateCopyInput,
  type TemplateSaveDraft,
  type TemplateSaveCommand,
  type TemplateSaveReply,
} from "../lib/template-save-recovery";
const family = "mobile-template-save-draft";
export function useTemplateSaveDraft(scope: {
  orgId: string;
  userId: string;
  showId: string;
}) {
  return (
    useRetainedDraftList<TemplateSaveDraft | null>(family, scope).find(
      (draft) => draft?.showId === scope.showId,
    ) ?? null
  );
}
export function useTemplateSave(
  scope: { orgId: string; userId: string; showId: string },
  initial: TemplateCopyInput,
  options: {
    active: boolean;
    send: (
      command: TemplateSaveCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<TemplateSaveReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient(),
    key = [family, scope.userId, scope.orgId, scope.showId];
  const identity = JSON.stringify(key);
  const [issue, setIssue] = useState<{
    identity: string;
    message: string;
  } | null>(null);
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const draft = useTemplateSaveDraft(scope);
  const requests = useRetainedRequests(scope, {
    family: "mobile-template-save-request",
    scopeKey: scope.showId,
    enabled: options.active,
    slot: () => "save",
    send: (command: TemplateSaveCommand, signal) =>
      send(command, false, signal),
    review: (command, signal) => send(command, true, signal),
    parseResult: (input) => templateSaveReplySchema.parse(input),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The template save could not be confirmed. Retry or review the original save.",
    refresh: options.refresh,
  });
  const current = () => client.getQueryData<TemplateSaveDraft | null>(key);
  const attempt = () =>
    client.getQueryData<typeof requests.work>([
      "mobile-template-save-request",
      scope.userId,
      scope.orgId,
      scope.showId,
    ])?.save;
  function capture() {
    if (!requests.isActive() || attempt()) return;
    const parsed = templateCopySchema.safeParse(initial);
    if (!parsed.success) {
      setIssue({
        identity,
        message:
          "This rundown copy contains invalid details. Refresh the show, then capture its current rundown again.",
      });
      return;
    }
    client.setQueryData<TemplateSaveDraft | null>(key, (value) => ({
      showId: scope.showId,
      name: value?.name ?? "",
      copy: parsed.data,
    }));
    setIssue(null);
  }
  useEffect(() => {
    if (options.active && !current() && !attempt()) capture();
    // A new source is adopted only on opening a new draft or explicit confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.orgId, scope.userId, scope.showId, options.active, draft]);

  async function send(
    command: TemplateSaveCommand,
    review: boolean,
    signal: AbortSignal,
  ) {
    const reply = templateSaveReplySchema.parse(
      await options.send(command, review, signal),
    );
    if (reply.showId !== command.showId)
      throw new Error("The reply belongs to another show.");
    return reply;
  }
  function update(fn: (draft: TemplateSaveDraft) => TemplateSaveDraft) {
    if (!requests.isActive() || attempt()) return;
    client.setQueryData<TemplateSaveDraft | null>(key, (value) =>
      value ? fn(value) : value,
    );
  }
  function clear() {
    const work = attempt();
    if (
      !requests.isActive() ||
      (work && (work.kind !== "confirmed" || work.refresh !== "done"))
    )
      return false;
    if (work) requests.dismiss("save");
    client.setQueryData<TemplateSaveDraft | null>(key, null);
    return true;
  }
  return {
    draft,
    attempt: requests.work.save,
    locked: !!requests.work.save,
    setName: (name: string) => update((value) => ({ ...value, name })),
    replaceCopy: capture,
    capture,
    error: issue?.identity === identity ? issue.message : undefined,
    submit: () => {
      const value = current();
      if (!requests.isActive() || attempt() || !value) return;
      const parsed = templateSaveCommandSchema.safeParse({
        ...value.copy,
        name: value.name,
        orgId: scope.orgId,
        userId: scope.userId,
        showId: scope.showId,
        requestId: createLocalRequestUuid(),
      });
      if (parsed.success) {
        setIssue(null);
        requests.start(parsed.data, value.name);
      } else
        setIssue({
          identity,
          message: parsed.error.issues.some(
            (issue) => issue.message === templateSizeError,
          )
            ? templateSizeError
            : "Check the template name and reviewed rundown before saving.",
        });
    },
    clear,
    retry: () => requests.retry("save"),
    review: () => requests.review("save"),
    refresh: () => requests.refresh("save"),
    editCancelled: () => {
      const work = attempt();
      if (
        requests.isActive() &&
        work?.kind === "confirmed" &&
        work.refresh === "done" &&
        work.result.outcome === "cancelled"
      )
        requests.dismiss("save");
    },
  };
}
