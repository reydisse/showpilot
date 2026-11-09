import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseTimecodeString, sameTimecodeClockReview, type TimecodeFormat } from "@showpilot/shared";
import type { MobileTimecodeState } from "../lib/timecode-contract";
import { createLocalRequestUuid } from "../lib/request-id";
import { reviewTimecodeClock, timecodeClockCommandSchema, timecodeClockReplySchema,
  type TimecodeClockCommand, type TimecodeClockDraft, type TimecodeClockReply } from "../lib/timecode-clock-recovery";
import { useRetainedRequests } from "./use-retained-requests";

type Scope = { orgId: string; userId: string; showId: string; serviceDate: string };
const family = "mobile-timecode-clock-draft", requestsFamily = "mobile-timecode-clock-request";
export function useTimecodeClockEdit(scope: Scope, options: {
  active: boolean; canSend: boolean; state: MobileTimecodeState | undefined;
  send: (command: TimecodeClockCommand, signal: AbortSignal) => Promise<TimecodeClockReply>;
  refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = useMemo(() => [family, scope.userId, scope.orgId, scope.showId], [scope.userId, scope.orgId, scope.showId]);
  const identity = JSON.stringify(key);
  const empty: TimecodeClockDraft = { timecode: "00:00:00:00", review: null };
  const { data: draft } = useQuery({ queryKey: key, queryFn: () => empty, initialData: empty, enabled: false, gcTime: Infinity });
  const [issue, setIssue] = useState<{ identity: string; message: string } | null>(null);
  const requests = useRetainedRequests(scope, {
    family: requestsFamily, scopeKey: scope.showId, enabled: options.active, slot: () => "edit",
    send: async (command: TimecodeClockCommand, signal) => {
      const result = timecodeClockReplySchema.parse(await options.send(command, signal));
      if (result.showId !== command.expected.showId) throw new Error("The clock reply belongs to a different show.");
      return result;
    },
    parseResult: value => timecodeClockReplySchema.parse(value), retryable: () => false, dismissible: () => true,
    failureMessage: "The clock change was not confirmed. It may have completed. Retry the original request. A completed change will not be applied again.",
    refreshFailureMessage: "The clock result is known, but its current state could not refresh. Retry the refresh.",
    refresh: options.refresh,
  });
  const attempt = () => client.getQueryData<typeof requests.work>([requestsFamily, scope.userId, scope.orgId, scope.showId])?.edit;
  const put = (change: Partial<TimecodeClockDraft>) => client.setQueryData<TimecodeClockDraft>(key, value => value ? { ...value, ...change } : value);
  const current = () => client.getQueryData<TimecodeClockDraft>(key);
  const stopped = Boolean(options.state && !options.state.running && options.state.signal?.status !== "paused");
  const currentReview = options.state ? reviewTimecodeClock(options.state) : null;
  const reviewChanged = Boolean(draft.review && (!currentReview || !sameTimecodeClockReview(draft.review.command.expected, currentReview)));
  const fail = (message: string) => setIssue({ identity, message });
  function prepare(kind: "seek" | "reformat", format?: TimecodeFormat) {
    if (!requests.isActive() || attempt()) return;
    if (!options.canSend || !stopped || !options.state) { fail("Connect, claim control and stop the source before reviewing a clock change."); return; }
    if (kind === "seek" && options.state.incomingFormat) { fail("Review the detected input format before changing the clock position."); return; }
    const value = current();
    if (!value) return;
    const common = { orgId: scope.orgId, userId: scope.userId, requestId: createLocalRequestUuid(),
      expected: reviewTimecodeClock(options.state), confirmed: true as const };
    try {
      const timecode = parseTimecodeString(value.timecode.trim(), options.state.format);
      if (kind === "seek" && !timecode) { fail("Enter a valid clock time for the current frame rate, including drop-frame labels."); return; }
      const command = timecodeClockCommandSchema.parse(kind === "seek" ? { ...common, kind, timecode } : { ...common, kind, format });
      put({ review: { command, from: options.state.display } }); setIssue(null);
    } catch { fail("Review a valid clock time or frame rate before continuing."); }
  }
  return {
    draft, attempt: requests.work.edit, locked: Boolean(draft.review || requests.work.edit),
    reviewChanged, canReview: options.canSend && stopped, canConfirm: options.canSend && stopped && !reviewChanged,
    error: issue?.identity === identity ? issue.message : null,
    update: (timecode: string) => { if (requests.isActive() && !attempt() && !current()?.review) { put({ timecode }); setIssue(null); } },
    prepare,
    cancel: () => { if (requests.isActive() && !attempt()) { put({ review: null }); setIssue(null); } },
    reviewCurrent: () => { const review = current()?.review; if (review) prepare(review.command.kind, review.command.kind === "reformat" ? review.command.format : undefined); },
    confirm: () => {
      const review = current()?.review;
      if (!requests.isActive() || attempt() || !review || !options.canSend || !stopped || !currentReview || !sameTimecodeClockReview(review.command.expected, currentReview)) return;
      put({ review: null }); requests.start(review.command, review.command.kind === "seek" ? "Change clock position" : "Reformat timeline");
    },
    retry: () => { if (requests.isActive() && options.canSend) requests.retry("edit"); },
    refresh: () => requests.refresh("edit"),
    finish: () => { const value = attempt(); if (requests.isActive() && value?.kind === "confirmed" && value.refresh === "done") { requests.dismiss("edit"); setIssue(null); } },
  };
}
