import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimecodeFormat } from "@showpilot/shared";
import type { MobileTimecodeEvent } from "../lib/timecode-contract";
import type { TimecodeCueDraft } from "../lib/timecode-cue-recovery";
import { cueEditChanged, cueEditReplySchema, draftCueEdit, prepareCueEdit, type CueEditCommand, type CueEditDraft, type CueEditReply } from "../lib/timecode-cue-edit-recovery";
import { createLocalRequestUuid } from "../lib/request-id";
import { useRetainedRequests } from "./use-retained-requests";
type Scope = { orgId: string; userId: string; showId: string; serviceDate: string };
const family = "mobile-timecode-cue-edit-draft", requestFamily = "mobile-timecode-cue-edits";
export function useTimecodeCueEdit(scope: Scope, options: {
  active: boolean; canSend: boolean; format: TimecodeFormat | undefined; events: MobileTimecodeEvent[];
  send: (command: CueEditCommand, signal: AbortSignal) => Promise<CueEditReply>;
  refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = useMemo(() => [family, scope.userId, scope.orgId, scope.showId], [scope.userId, scope.orgId, scope.showId]);
  const identity = JSON.stringify(key);
  const { data: draft } = useQuery<CueEditDraft | null>({ queryKey: key, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity });
  const [issue, setIssue] = useState<{ identity: string; message: string } | null>(null);
  const requests = useRetainedRequests<CueEditCommand, CueEditReply>(scope, {
    family: requestFamily, scopeKey: scope.showId, enabled: options.active, slot: () => "edit",
    send: async (command, signal) => {
      const reply = cueEditReplySchema.parse(await options.send(command, signal));
      if (reply.showId !== command.showId) throw new Error("The edit reply belongs to another show.");
      return reply;
    },
    parseResult: value => cueEditReplySchema.parse(value), retryable: () => false, dismissible: () => true,
    failureMessage: "The cue edit was not confirmed. Your draft is kept. Retry the original save to recover its result without overwriting later changes.",
    refreshFailureMessage: "The edit result is known, but the current timeline could not refresh. Retry the refresh.", refresh: options.refresh,
  });
  const attempt = () => client.getQueryData<typeof requests.work>([requestFamily, scope.userId, scope.orgId, scope.showId])?.edit;
  const current = () => client.getQueryData<CueEditDraft | null>(key);
  const fail = (message: string) => setIssue({ identity, message });
  const changed = (value: CueEditDraft) => cueEditChanged(value, options.events.find(event => event.id === value.id), options.format);
  function begin(id: string) {
    if (!requests.isActive() || attempt() || current()) return;
    const event = options.events.find(event => event.id === id);
    if (!options.canSend || !options.format || !event || event.executionStatus === "dispatching") {
      fail("Connect, claim control and wait for the cue's delivery result before editing."); return;
    }
    client.setQueryData(key, draftCueEdit(scope.showId, event, options.format)); setIssue(null);
  }
  return {
    draft, attempt: requests.work.edit, locked: Boolean(draft || requests.work.edit), changed: draft ? changed(draft) : false,
    error: issue?.identity === identity ? issue.message : null,
    begin,
    update: (changes: Partial<Pick<TimecodeCueDraft, "label" | "timecode" | "payload" | "tolerance" | "lead">>) => {
      if (!requests.isActive() || attempt()) return;
      client.setQueryData<CueEditDraft | null>(key, value => value ? { ...value, definition: { ...value.definition, ...changes } } : value); setIssue(null);
    },
    changeDetails: (changeDetails: boolean) => {
      if (!requests.isActive() || attempt()) return;
      client.setQueryData<CueEditDraft | null>(key, value => value ? { ...value, changeDetails } : value);
    },
    // A stale edit never silently rebases onto a changed cue. Explicitly load
    // its current definition, or retain the old draft for comparison.
    reload: () => {
      const value = current(), event = options.events.find(event => event.id === value?.id);
      if (!requests.isActive() || attempt() || !options.canSend || !options.format || !event || event.executionStatus === "dispatching") return;
      client.setQueryData(key, draftCueEdit(scope.showId, event, options.format)); setIssue(null);
    },
    cancel: () => { if (requests.isActive() && !attempt()) { client.setQueryData(key, null); setIssue(null); } },
    save: () => {
      const value = current();
      if (!requests.isActive() || attempt() || !value) return;
      if (!options.canSend) { fail("Connect and claim control before saving the cue edit."); return; }
      if (changed(value)) { fail("This cue or frame rate changed. Your draft is kept. Load the current cue before editing again."); return; }
      try { requests.start(prepareCueEdit({ ...scope, requestId: createLocalRequestUuid() }, value), value.definition.label); setIssue(null); }
      catch (error) { fail(error instanceof Error ? error.message : "Review the cue fields before saving."); }
    },
    retry: () => { if (requests.isActive() && options.canSend) requests.retry("edit"); },
    refresh: () => requests.refresh("edit"),
    finish: () => {
      const value = attempt();
      if (!requests.isActive() || value?.kind !== "confirmed" || value.refresh !== "done") return;
      requests.dismiss("edit");
      if (value.result.outcome === "applied") client.setQueryData(key, null);
      setIssue(null);
    },
  };
}
