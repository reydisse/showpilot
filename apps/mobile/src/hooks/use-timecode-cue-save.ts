import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TimecodeFormat } from "@showpilot/shared";
import { useRetainedRequests } from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import { cueCreateReplySchema, prepareCueCreation, type CueCreateCommand, type CueCreateReply, type TimecodeCueDraft } from "../lib/timecode-cue-recovery";

type Scope = { orgId: string; userId: string; showId: string; serviceDate: string };
const family = "mobile-timecode-cue-draft";
const requestFamily = "mobile-timecode-cue-request";
export function useTimecodeCueSave(scope: Scope, options: {
  active: boolean;
  canSend: boolean;
  format: TimecodeFormat | undefined;
  send: (command: CueCreateCommand, signal: AbortSignal) => Promise<CueCreateReply>;
  refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = useMemo(() => [family, scope.userId, scope.orgId, scope.showId], [scope.userId, scope.orgId, scope.showId]);
  const identity = JSON.stringify(key);
  const empty = (): TimecodeCueDraft => ({ showId: scope.showId, label: "", timecode: "00:00:10:00",
    action: "rundown-advance", payload: "{}", format: options.format ?? null });
  const { data: draft } = useQuery({ queryKey: key, queryFn: empty, initialData: empty, enabled: false, gcTime: Infinity });
  const [issue, setIssue] = useState<{ identity: string; message: string } | null>(null);
  const requests = useRetainedRequests(scope, {
    family: requestFamily, scopeKey: scope.showId, enabled: options.active,
    slot: () => "save",
    send: async (command: CueCreateCommand, signal) => {
      const result = cueCreateReplySchema.parse(await options.send(command, signal));
      if (result.showId !== command.showId) throw new Error("The save reply belongs to a different show.");
      return result;
    },
    parseResult: value => cueCreateReplySchema.parse(value),
    retryable: () => false,
    dismissible: () => true,
    failureMessage: "The cue save was not confirmed. It may have completed. Your draft and original request are kept; retry that save to check its result.",
    refreshFailureMessage: "The saved cue's timeline could not refresh. Retry the refresh; the cue will not be saved again.",
    refresh: options.refresh,
  });
  const attempt = () => client.getQueryData<typeof requests.work>([requestFamily, scope.userId, scope.orgId, scope.showId])?.save;
  useEffect(() => {
    if (!options.active || !options.format) return;
    const format = options.format;
    client.setQueryData<TimecodeCueDraft>(key, value => value && !value.format ? { ...value, format } : value);
  }, [client, key, options.active, options.format]);
  function update(changes: Partial<Pick<TimecodeCueDraft, "label" | "timecode" | "action" | "payload">>) {
    if (!requests.isActive() || attempt()) return;
    client.setQueryData<TimecodeCueDraft>(key, value => value ? { ...value, ...changes } : value);
    setIssue(null);
  }
  function available() {
    if (!requests.isActive()) return false;
    if (options.canSend) return true;
    setIssue({ identity, message: "Connect to this show and claim control before saving or retrying a cue." });
    return false;
  }
  return {
    draft, attempt: requests.work.save, locked: Boolean(requests.work.save),
    error: issue?.identity === identity ? issue.message : null,
    update,
    reviewFormat: () => {
      if (!requests.isActive() || attempt() || !options.format) return;
      client.setQueryData<TimecodeCueDraft>(key, value => value ? { ...value, format: options.format ?? null } : value);
    },
    save: () => {
      if (!available() || attempt()) return;
      const value = client.getQueryData<TimecodeCueDraft>(key);
      if (!value) return;
      try {
        const command = prepareCueCreation({ ...scope, requestId: createLocalRequestUuid() }, value);
        setIssue(null); requests.start(command, value.label);
      } catch (error) {
        setIssue({ identity, message: error instanceof Error ? error.message : "Review the cue details before saving." });
      }
    },
    retry: () => { if (available()) requests.retry("save"); },
    refresh: () => requests.refresh("save"),
    finish: (keepDraft: boolean) => {
      const current = attempt();
      if (!requests.isActive() || current?.kind !== "confirmed" || current.refresh !== "done") return;
      requests.dismiss("save");
      if (!keepDraft) client.setQueryData<TimecodeCueDraft>(key, empty());
      setIssue(null);
    },
  };
}
