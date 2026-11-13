import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reviewTimecodeCue, sameTimecodeCueReviews, sameTimecodeClockReview, type TimecodeCueOperation } from "@showpilot/shared";
import type { MobileTimecodeEvent, MobileTimecodeState } from "../lib/timecode-contract";
import { reviewTimecodeClock } from "../lib/timecode-clock-recovery";
import { createLocalRequestUuid } from "../lib/request-id";
import { mobileCueControlSchema, mobileCueControlReplySchema, cueControlLabels, cueControlDetails,
  type MobileCueControl, type MobileCueControlReply, type MobileCueControlReview } from "../lib/timecode-cue-control-recovery";
import { useRetainedRequests } from "./use-retained-requests";
type Scope = { orgId: string; userId: string; showId: string; serviceDate: string };
const family = "mobile-timecode-cue-control-review", requestsFamily = "mobile-timecode-cue-controls";
export function useTimecodeCueControls(scope: Scope, options: {
  active: boolean; canSend: boolean; state: MobileTimecodeState | undefined; events: MobileTimecodeEvent[];
  send: (command: MobileCueControl, signal: AbortSignal) => Promise<MobileCueControlReply>;
  refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = useMemo(() => [family, scope.userId, scope.orgId, scope.showId], [scope.userId, scope.orgId, scope.showId]);
  const identity = JSON.stringify(key);
  const { data: review } = useQuery<MobileCueControlReview | null>({ queryKey: key, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity });
  const [issue, setIssue] = useState<{ identity: string; message: string } | null>(null);
  const requests = useRetainedRequests<MobileCueControl, MobileCueControlReply>(scope, {
    family: requestsFamily, scopeKey: scope.showId, enabled: options.active, slot: () => "control",
    send: async (command, signal) => {
      const result = mobileCueControlReplySchema.parse(await options.send(command, signal));
      if (result.showId !== command.showId) throw new Error("The cue result belongs to another show.");
      return result;
    },
    parseResult: value => mobileCueControlReplySchema.parse(value), retryable: () => false, dismissible: () => true,
    failureMessage: "The cue action was not confirmed. It may have completed. Retry the original request to recover its result without repeating a completed action.",
    refreshFailureMessage: "The action result is known, but the current cues could not refresh. Retry the refresh.", refresh: options.refresh,
  });
  const attempt = () => client.getQueryData<typeof requests.work>([requestsFamily, scope.userId, scope.orgId, scope.showId])?.control;
  const currentReview = () => client.getQueryData<MobileCueControlReview | null>(key);
  const canReview = options.canSend && options.state?.showId === scope.showId && options.state.serviceDate === scope.serviceDate;
  function changed(value: MobileCueControlReview) {
    const command = value.command;
    const selected = command.operation === "reset" ? options.events : options.events.filter(event => event.id === command.expected[0].id);
    return !sameTimecodeCueReviews(command.expected, selected.map(reviewTimecodeCue)) || command.serviceDate !== options.state?.serviceDate
      || ("gateRevision" in command && (command.gateRevision !== options.state?.automationRevision || !options.state?.triggersEnabled))
      || (command.operation === "reset" && (!options.state || options.state.running || !sameTimecodeClockReview(command.clock, reviewTimecodeClock(options.state))));
  }
  function prepare(operation: TimecodeCueOperation, id?: string) {
    if (!requests.isActive() || attempt()) return;
    const fail = (message: string) => setIssue({ identity, message });
    if (!canReview || !options.state) { fail("Connect and claim control before changing cues."); return; }
    const selected = operation === "reset" ? options.events : options.events.filter(event => event.id === id);
    if (!selected.length) { fail("The cue is no longer in this show. Refresh the timeline."); return; }
    if (operation === "reset" && options.state.running) { fail("Stop the clock before reviewing a timeline reset."); return; }
    if ((operation === "fire" || operation === "retry" || operation === "refire") && !options.state.triggersEnabled) {
      fail("Enable automation before firing this cue."); return;
    }
    if (operation !== "enable" && operation !== "disable" && selected.some(event => event.executionStatus === "dispatching")) {
      fail("Wait for the cue's delivery result before changing its history."); return;
    }
    const parsed = mobileCueControlSchema.safeParse({ ...scope, requestId: createLocalRequestUuid(), operation, confirmed: true, gateRevision: options.state.automationRevision,
      expected: selected.map(reviewTimecodeCue), ...(operation === "reset" ? { clock: reviewTimecodeClock(options.state) } : {}) });
    if (!parsed.success) { fail("Cue details could not be validated. Refresh the timeline before reviewing it again."); return; }
    const command = parsed.data;
    const label = operation === "reset" ? `All ${selected.length} cues` : selected[0].label;
    setIssue(null);
    if (operation === "enable" || operation === "disable") requests.start(command, `${cueControlLabels[operation]}: ${label}`);
    else client.setQueryData<MobileCueControlReview>(key, { command, label, detail: cueControlDetails[operation] });
  }
  return {
    review, changed: review ? changed(review) : false, canReview, attempt: requests.work.control,
    locked: Boolean(review || requests.work.control), error: issue?.identity === identity ? issue.message : null,
    prepare,
    cancel: () => { if (requests.isActive() && !attempt()) client.setQueryData(key, null); },
    reviewCurrent: () => { const value = currentReview(); if (value) prepare(value.command.operation, value.command.expected[0].id); },
    confirm: () => {
      const value = currentReview();
      if (!requests.isActive() || attempt() || !value || !canReview || changed(value)) return;
      client.setQueryData(key, null); requests.start(value.command, `${cueControlLabels[value.command.operation]}: ${value.label}`);
    },
    retry: () => { if (requests.isActive() && options.canSend) requests.retry("control"); },
    refresh: () => requests.refresh("control"), finish: () => requests.dismiss("control"),
  };
}
