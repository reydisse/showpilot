import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { sameTimecodeGateReview } from "@showpilot/shared";
import type { MobileTimecodeState } from "../lib/timecode-contract";
import { createLocalRequestUuid } from "../lib/request-id";
import { mobileGateCommandSchema, mobileGateReplySchema, reviewAutomationGate,
  type MobileGateCommand, type MobileGateReply, type MobileGateReview } from "../lib/timecode-automation-recovery";
import { useRetainedRequests } from "./use-retained-requests";
type Scope = { orgId: string; userId: string; showId: string; serviceDate: string };
const family = "mobile-timecode-gate-review", requestsFamily = "mobile-timecode-gate-requests";
export function useTimecodeAutomationGate(scope: Scope, options: {
  active: boolean; canSend: boolean; canResume: boolean; state: MobileTimecodeState | undefined;
  send: (command: MobileGateCommand, signal: AbortSignal) => Promise<MobileGateReply>;
  refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = useMemo(() => [family, scope.userId, scope.orgId, scope.showId], [scope.userId, scope.orgId, scope.showId]);
  const identity = JSON.stringify(key);
  const { data: review } = useQuery<MobileGateReview | null>({ queryKey: key, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity });
  const [issue, setIssue] = useState<{ identity: string; message: string } | null>(null);
  const requests = useRetainedRequests<MobileGateCommand, MobileGateReply>(scope, {
    family: requestsFamily, scopeKey: scope.showId, enabled: options.active, slot: command => command.requestId,
    send: async (command: MobileGateCommand, signal) => {
      const result = mobileGateReplySchema.parse(await options.send(command, signal));
      if (result.showId !== command.showId) throw new Error("The automation reply belongs to another show.");
      return result;
    },
    parseResult: value => mobileGateReplySchema.parse(value), retryable: () => false, dismissible: () => true,
    failureMessage: "The automation change was not confirmed. It may have completed. Retry the original request to recover its result. A completed change will not be applied again.",
    refreshFailureMessage: "The automation result is known, but the current state could not refresh. Retry its refresh.", refresh: options.refresh,
  });
  const work = () => client.getQueryData<typeof requests.work>([requestsFamily, scope.userId, scope.orgId, scope.showId]) ?? {};
  const currentReview = () => client.getQueryData<MobileGateReview | null>(key);
  const current = options.state ? reviewAutomationGate(options.state) : null;
  const targetMatches = options.state?.showId === scope.showId && options.state.serviceDate === scope.serviceDate;
  const canReview = options.canSend && options.canResume && targetMatches && Boolean(current) && !options.state?.incomingFormat;
  const changed = Boolean(review && (!targetMatches || !current || !sameTimecodeGateReview(review.command.expected, current)));
  function prepare(operation: "resume" | "resume-automatic") {
    if (!requests.isActive() || Object.keys(work()).length) return;
    if (!canReview || !current || !options.state) {
      setIssue({ identity, message: "Connect, claim control and resolve the input format before reviewing automation." }); return;
    }
    if (operation === "resume-automatic" && (!options.state.triggersEnabled || options.state.automationHold)) {
      setIssue({ identity, message: "Enable automation and review its safety hold first." }); return;
    }
    const command = mobileGateCommandSchema.parse({ ...scope, requestId: createLocalRequestUuid(), operation, confirmed: true, expected: current });
    if (command.operation === "stop") return;
    client.setQueryData<MobileGateReview>(key, { command, reason: options.state.automationHold
      ? `Clock jump: ${options.state.automationHold.from} → ${options.state.automationHold.to}.`
      : operation === "resume" ? "Automation was stopped." : "A cue paused automatic firing." });
    setIssue(null);
  }
  return {
    review, changed, canReview, work: requests.work, locked: Boolean(review || Object.keys(requests.work).length),
    stopping: Object.values(requests.work).some(value => value.command.operation === "stop" && value.kind === "pending"),
    error: issue?.identity === identity ? issue.message : null,
    prepare,
    cancel: () => { if (requests.isActive()) client.setQueryData(key, null); },
    reviewCurrent: () => { const value = currentReview(); if (value) prepare(value.command.operation); },
    confirm: () => {
      const value = currentReview();
      if (!requests.isActive() || Object.keys(work()).length || !value || !canReview || !current || !sameTimecodeGateReview(value.command.expected, current)) return;
      client.setQueryData(key, null);
      requests.start(value.command, value.command.operation === "resume" ? "Resume automation" : "Resume automatic cues");
    },
    stop: () => {
      if (!requests.isActive() || !options.canSend || !targetMatches || Object.values(work()).some(value => value.command.operation === "stop" && value.kind === "pending")) return;
      client.setQueryData(key, null);
      // Emergency Stop remains available during other pending/failed operations.
      requests.start({ ...scope, requestId: createLocalRequestUuid(), operation: "stop" }, "Stop automation");
    },
    retry: (id: string) => { if (requests.isActive() && options.canSend) requests.retry(id); },
    refresh: requests.refresh,
    finish: (id: string) => requests.dismiss(id),
  };
}
