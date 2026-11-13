import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lyricsReviewMatches, lyricsReviewState, type LyricsOperation } from "@showpilot/shared";
import type { MobileTimecodeState } from "../lib/timecode-contract";
import { createLocalRequestUuid } from "../lib/request-id";
import { lyricsControlReplySchema, lyricsControlLabels, type MobileLyricsControl, type MobileLyricsReply, type MobileLyricsReview } from "../lib/timecode-lyrics-recovery";
import { useRetainedRequests } from "./use-retained-requests";
type Scope = { orgId: string; userId: string; showId: string; serviceDate: string };
const family = "mobile-timecode-lyrics-review", requestsFamily = "mobile-timecode-lyrics-controls";
export function useTimecodeLyricsControls(scope: Scope, options: {
  active: boolean; canSend: boolean; state: MobileTimecodeState | undefined;
  send: (command: MobileLyricsControl, signal: AbortSignal) => Promise<MobileLyricsReply>;
  refresh: (signal: AbortSignal) => Promise<void>;
}) {
  const client = useQueryClient();
  const key = useMemo(() => [family, scope.userId, scope.orgId, scope.showId], [scope.userId, scope.orgId, scope.showId]);
  const identity = JSON.stringify(key);
  const { data: review } = useQuery<MobileLyricsReview | null>({ queryKey: key, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity });
  const [issue, setIssue] = useState<{ identity: string; message: string } | null>(null);
  const requests = useRetainedRequests<MobileLyricsControl, MobileLyricsReply>(scope, {
    family: requestsFamily, scopeKey: scope.showId, enabled: options.active, slot: () => "lyrics",
    send: async (command, signal) => {
      const result = lyricsControlReplySchema.parse(await options.send(command, signal));
      if (result.showId !== command.showId) throw new Error("The lyrics result belongs to another show.");
      return result;
    },
    parseResult: value => lyricsControlReplySchema.parse(value), retryable: () => false, dismissible: () => true,
    failureMessage: "The lyrics change was not confirmed. It may have completed. Retry the original request to recover its result without advancing or clearing again.",
    refreshFailureMessage: "The lyrics result is known, but the current display could not refresh. Retry the refresh.", refresh: options.refresh,
  });
  const attempt = () => client.getQueryData<typeof requests.work>([requestsFamily, scope.userId, scope.orgId, scope.showId])?.lyrics;
  const currentReview = () => client.getQueryData<MobileLyricsReview | null>(key);
  const canReview = options.canSend && Boolean(options.state?.lyrics) && options.state?.showId === scope.showId && options.state.serviceDate === scope.serviceDate;
  const changed = (value: MobileLyricsReview) => value.command.serviceDate !== options.state?.serviceDate
    || value.command.showId !== options.state?.showId || !lyricsReviewMatches(options.state?.lyrics ?? null, value.command.expected);
  function prepare(operation: LyricsOperation) {
    if (!requests.isActive() || attempt()) return;
    const lyrics = options.state?.lyrics;
    if (!canReview || !lyrics) { setIssue({ identity, message: "Connect, claim control and show a song section before changing lyrics." }); return; }
    client.setQueryData<MobileLyricsReview>(key, { command: { ...scope, requestId: createLocalRequestUuid(), operation, expected: lyricsReviewState(lyrics) },
      songTitle: lyrics.songTitle, sectionLabel: lyrics.sectionLabel }); setIssue(null);
  }
  return {
    review, changed: review ? changed(review) : false, canReview, canRecover: options.canSend, attempt: requests.work.lyrics,
    locked: Boolean(review || requests.work.lyrics), error: issue?.identity === identity ? issue.message : null,
    prepare,
    cancel: () => { if (requests.isActive() && !attempt()) client.setQueryData(key, null); },
    reviewCurrent: () => { const value = currentReview(); if (value) prepare(value.command.operation); },
    confirm: () => {
      const value = currentReview();
      if (!requests.isActive() || attempt() || !value || !canReview || changed(value)) return;
      client.setQueryData(key, null); requests.start(value.command, `${lyricsControlLabels[value.command.operation]} · ${value.songTitle} · ${value.sectionLabel}`);
    },
    // Recovery is available even after Clear removed the displayed lyrics.
    retry: () => { if (requests.isActive() && options.canSend) requests.retry("lyrics"); },
    refresh: () => requests.refresh("lyrics"), finish: () => requests.dismiss("lyrics"),
  };
}
