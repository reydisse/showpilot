import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { destinationControlSnapshotSchema, destinationControlResultSchema, destinationFieldsSchema,
  type DestinationControlScope, type DestinationControlCommand, type DestinationControlOperation,
  type DestinationControlSnapshot, type DestinationControlResult, type DestinationFields,
} from "@showpilot/shared/destination-control";
import { useRetainedRequests, useRetainedDraftList, type RetainedAttempt } from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";

type Destination = DestinationControlSnapshot["destinations"][number];
type Draft = { token: string; fields: DestinationFields; base: { id: string; revision: number } | null; commandId?: string };
export type DestinationReview = DestinationControlScope & { operation: DestinationControlOperation; label: string; draftToken?: string };
export function useDestinationControl(scope: DestinationControlScope, options: {
  enabled: boolean; pollingInterval: number | false;
  read: (scope: DestinationControlScope, signal: AbortSignal) => Promise<DestinationControlSnapshot>;
  send: (command: DestinationControlCommand, signal: AbortSignal, review?: boolean) => Promise<DestinationControlResult>;
}) {
  const client = useQueryClient();
  const queryKey = ["mobile-destination-control", scope.userId, scope.orgId];
  const draftKey = ["mobile-destination-draft", scope.userId, scope.orgId, "editor"];
  const workKey = ["mobile-destination-requests", scope.userId, scope.orgId];
  const draft = useRetainedDraftList<Draft>("mobile-destination-draft", scope)[0];
  const read = (signal: AbortSignal) => runMobileOperation(async child => {
    const data = destinationControlSnapshotSchema.parse(await options.read(scope, child.signal));
    if (data.orgId !== scope.orgId || data.userId !== scope.userId) throw new Error("Destinations belong to a different workspace or account.");
    return data;
  }, signal, 10_000);
  const pollingInterval = (query: { state: { status: string } }) => query.state.status === "error" ? false : options.pollingInterval;
  const state = useQuery({ queryKey, enabled: options.enabled, retry: false, networkMode: "always", refetchInterval: pollingInterval, queryFn: ({ signal }) => read(signal) });
  const requests = useRetainedRequests<DestinationControlCommand, DestinationControlResult>(scope, {
    family: "mobile-destination-requests", enabled: options.enabled, slot: () => "destination",
    send: options.send, review: (command, signal) => options.send(command, signal, true),
    parseResult: destinationControlResultSchema.parse, retryable: result => result.outcome === "unconfirmed", dismissible: result => result.outcome !== "unconfirmed",
    failureMessage: "The destination change was not confirmed. Retry the original request or review whether it arrived.",
    refreshFailureMessage: "The result is saved, but current destinations could not refresh. Retry the read.",
    refresh: async signal => {
      await client.cancelQueries({ queryKey, exact: true });
      await client.fetchQuery({ queryKey, staleTime: 0, retry: false, queryFn: () => read(signal) });
    },
  });
  type Attempt = RetainedAttempt<DestinationControlCommand, DestinationControlResult>;
  const attempt = requests.work.destination;
  const complete = (value: Attempt | undefined) => !value || (value.kind === "confirmed" && value.refresh === "done" && value.result.outcome !== "unconfirmed");
  const settled = complete(attempt);
  const isSettled = () => complete(client.getQueryData<Record<string, Attempt>>(workKey)?.destination);
  const currentDraft = () => client.getQueryData<Draft>(draftKey);
  const currentState = () => client.getQueryData<DestinationControlSnapshot>(queryKey);
  const available = () => requests.isActive() && isSettled() && client.getQueryState(queryKey)?.status === "success" && !!currentState()?.canManage;
  function putDraft(next: Draft | undefined) {
    if (!requests.isActive()) return;
    client.setQueryDefaults(draftKey, { gcTime: Infinity });
    if (next) client.setQueryData(draftKey, next);
    else client.removeQueries({ queryKey: draftKey, exact: true });
  }
  useEffect(() => {
    if (attempt?.kind === "confirmed" && attempt.result.outcome === "applied" && attempt.refresh === "done" && currentDraft()?.commandId === attempt.command.requestId) putDraft(undefined);
  });
  function matches(review: DestinationReview) {
    const data = currentState(), op = review.operation;
    if (!available() || !data || review.orgId !== scope.orgId || review.userId !== scope.userId) return false;
    if (review.draftToken && review.draftToken !== currentDraft()?.token) return false;
    return op.kind === "create" || data.destinations.some(d => d.id === op.id && d.revision === op.expectedRevision);
  }
  function prepare(kind: "select" | "disable" | "delete", destination: Destination): DestinationReview | null {
    if (!available()) return null;
    return { ...scope, operation: { kind, id: destination.id, expectedRevision: destination.revision, expiresAt: 1 }, label: destination.name };
  }
  function prepareSave(): DestinationReview | null {
    const edit = currentDraft();
    if (!edit || !available()) return null;
    const fields = destinationFieldsSchema.safeParse(edit.fields);
    if (!fields.success || (!edit.base && !fields.data.streamKey.trim())) return null;
    const operation: DestinationControlOperation = edit.base
      ? { kind: "update", id: edit.base.id, expectedRevision: edit.base.revision, fields: fields.data }
      : { kind: "create", fields: fields.data };
    return { ...scope, operation, label: fields.data.name, draftToken: edit.token };
  }
  function confirm(review: DestinationReview) {
    if (!matches(review)) return false;
    const data = currentState()!, op = review.operation;
    const operation = op.kind === "create" || op.kind === "update" ? op
      : { ...op, expiresAt: data.serverTime + Math.max(0, Date.now() - (client.getQueryState(queryKey)?.dataUpdatedAt ?? Date.now())) + 4000 };
    const requestId = createLocalRequestUuid();
    if (attempt) requests.dismiss("destination");
    const edit = currentDraft();
    if (edit && (review.draftToken === edit.token || (op.kind === "delete" && edit.base?.id === op.id))) putDraft({ ...edit, commandId: requestId });
    requests.start({ ...scope, requestId, operation }, review.label); return true;
  }
  const data = state.data, readFailed = state.isError;
  const draftCurrent = draft?.base ? data?.destinations.find(d => d.id === draft.base!.id) : null;
  return {
    state, attempt, draft, draftCurrent, settled,
    draftStale: !!draft?.base && (!draftCurrent || draftCurrent.revision !== draft.base.revision),
    canStart: options.enabled && settled && !!data?.canManage && !readFailed,
    matches, prepare, prepareSave, confirm,
    edit(destination?: Destination) {
      if (!available() || currentDraft()) return;
      putDraft({ token: createLocalRequestUuid(), fields: destination ? { name: destination.name, platform: destination.platform, rtmpUrl: destination.rtmpUrl, streamKey: "" } : { name: "", platform: "custom", rtmpUrl: "rtmps://", streamKey: "" }, base: destination ? { id: destination.id, revision: destination.revision } : null });
    },
    change(fields: DestinationFields) {
      const edit = currentDraft();
      if (edit && isSettled() && requests.isActive()) putDraft({ ...edit, token: createLocalRequestUuid(), fields, commandId: undefined });
    },
    discard() { if (isSettled()) putDraft(undefined); },
    rebase() {
      const edit = currentDraft(), current = currentState()?.destinations.find(d => d.id === edit?.base?.id);
      if (edit && current && available()) putDraft({ ...edit, token: createLocalRequestUuid(), base: { id: current.id, revision: current.revision }, commandId: undefined });
    },
    retry: () => requests.retry("destination"), review: () => requests.review("destination"),
    refresh: () => requests.refresh("destination"), dismiss: () => requests.dismiss("destination"),
  };
}
