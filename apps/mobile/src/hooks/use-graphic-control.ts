import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  graphicControlSnapshotSchema, graphicControlResultSchema, graphicTextSchema,
  type GraphicControlScope, type GraphicControlCommand, type GraphicControlOperation,
  type GraphicControlSnapshot, type GraphicControlResult, type GraphicText,
} from "@showpilot/shared/graphic-control";
import { useRetainedRequests, useRetainedDraftList, type RetainedAttempt } from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";

type Graphic = GraphicControlSnapshot["templates"][number];
type Draft = { token: string; content: GraphicText; base: { id: string; revision: number } | null; commandId?: string };
export type GraphicReview = GraphicControlScope & { operation: GraphicControlOperation; label: string; draftToken?: string };
export function useGraphicControl(scope: GraphicControlScope, options: {
  enabled: boolean; pollingInterval: number | false;
  read: (scope: GraphicControlScope, signal: AbortSignal) => Promise<GraphicControlSnapshot>;
  send: (command: GraphicControlCommand, signal: AbortSignal, review?: boolean) => Promise<GraphicControlResult>;
}) {
  const client = useQueryClient();
  const queryKey = ["mobile-graphic-control", scope.userId, scope.orgId];
  const draftKey = ["mobile-graphic-draft", scope.userId, scope.orgId, "editor"];
  const draft = useRetainedDraftList<Draft>("mobile-graphic-draft", scope)[0];
  const read = (signal: AbortSignal) => runMobileOperation(async child => {
    const data = graphicControlSnapshotSchema.parse(await options.read(scope, child.signal));
    if (data.orgId !== scope.orgId || data.userId !== scope.userId) throw new Error("Graphics belong to a different workspace or account.");
    return data;
  }, signal, 10_000);
  const pollingInterval = (query: { state: { status: string } }) => query.state.status === "error" ? false : options.pollingInterval;
  const state = useQuery({ queryKey, enabled: options.enabled, retry: false, networkMode: "always", refetchInterval: pollingInterval, queryFn: ({ signal }) => read(signal) });
  const requests = useRetainedRequests<GraphicControlCommand, GraphicControlResult>(scope, {
    family: "mobile-graphic-requests", enabled: options.enabled, slot: () => "graphics",
    send: options.send, review: (command, signal) => options.send(command, signal, true),
    parseResult: graphicControlResultSchema.parse, retryable: () => false, dismissible: () => true,
    failureMessage: "The graphics change was not confirmed. Retry the original request or review whether it arrived.",
    refreshFailureMessage: "The result is saved, but current graphics could not refresh. Retry the read.",
    refresh: async signal => {
      await client.cancelQueries({ queryKey, exact: true });
      await client.fetchQuery({ queryKey, staleTime: 0, retry: false, queryFn: () => read(signal) });
    },
  });
  const attempt = requests.work.graphics;
  const settled = !attempt || (attempt.kind === "confirmed" && attempt.refresh === "done");
  const currentDraft = () => client.getQueryData<Draft>(draftKey);
  const currentState = () => client.getQueryData<GraphicControlSnapshot>(queryKey);
  const isSettled = () => {
    const current = client.getQueryData<Record<string, RetainedAttempt<GraphicControlCommand, GraphicControlResult>>>(["mobile-graphic-requests", scope.userId, scope.orgId])?.graphics;
    return !current || (current.kind === "confirmed" && current.refresh === "done");
  };
  const available = () => requests.isActive() && isSettled() && client.getQueryState(queryKey)?.status === "success" && !!currentState()?.cloudEnabled;
  function putDraft(next: Draft | undefined) {
    if (!requests.isActive()) return;
    client.setQueryDefaults(draftKey, { gcTime: Infinity });
    if (next) client.setQueryData(draftKey, next);
    else client.removeQueries({ queryKey: draftKey, exact: true });
  }
  useEffect(() => {
    if (attempt?.kind !== "confirmed" || attempt.result.outcome !== "applied" || attempt.refresh !== "done") return;
    if (currentDraft()?.commandId === attempt.command.requestId) putDraft(undefined);
  });
  function matches(review: GraphicReview) {
    const data = currentState(), op = review.operation;
    if (!available() || !data || review.orgId !== scope.orgId || review.userId !== scope.userId) return false;
    const output = op.kind === "show" || op.kind === "hide" || op.kind === "clear";
    if (output ? !data.canTrigger : !data.canConfigure) return false;
    if (review.draftToken && review.draftToken !== currentDraft()?.token) return false;
    if (op.kind === "create") return true;
    if (op.expectedProgramRevision !== data.programRevision) return false;
    if (op.kind === "clear") return true;
    return !data.unknownProgram && data.templates.some(g => g.id === op.id && g.revision === op.expectedGraphicRevision);
  }
  function prepare(kind: "show" | "hide" | "clear" | "delete", graphic?: Graphic): GraphicReview | null {
    const data = currentState();
    if (!data || !available()) return null;
    const base = { expectedProgramRevision: data.programRevision };
    let operation: GraphicControlOperation;
    if (kind === "clear") operation = { kind, ...base, expiresAt: 1 };
    else {
      if (!graphic) return null;
      const existing = { ...base, id: graphic.id, expectedGraphicRevision: graphic.revision };
      operation = kind === "delete" ? { kind, ...existing } : { kind, ...existing, expiresAt: 1 };
    }
    return { ...scope, operation, label: kind === "clear" ? "Clear program graphics" : graphic!.name };
  }
  function prepareSave(): GraphicReview | null {
    const edit = currentDraft(), data = currentState();
    if (!edit || !data || !available()) return null;
    const content = graphicTextSchema.safeParse(edit.content);
    if (!content.success) return null;
    const operation: GraphicControlOperation = edit.base
      ? { kind: "update", id: edit.base.id, expectedGraphicRevision: edit.base.revision, expectedProgramRevision: data.programRevision, content: content.data }
      : { kind: "create", content: content.data };
    return { ...scope, operation, label: content.data.name, draftToken: edit.token };
  }
  function confirm(review: GraphicReview) {
    if (!matches(review)) return false;
    const data = currentState()!, op = review.operation;
    const operation = op.kind === "show" || op.kind === "hide" || op.kind === "clear"
      ? { ...op, expiresAt: data.serverTime + Math.max(0, Date.now() - (client.getQueryState(queryKey)?.dataUpdatedAt ?? Date.now())) + 4000 }
      : op;
    const requestId = createLocalRequestUuid();
    if (attempt) requests.dismiss("graphics");
    const edit = currentDraft();
    if (edit && (review.draftToken === edit.token || (op.kind === "delete" && edit.base?.id === op.id))) putDraft({ ...edit, commandId: requestId });
    requests.start({ ...scope, requestId, operation }, review.label);
    return true;
  }
  const data = state.data, readFailed = state.isError;
  const draftCurrent = draft?.base ? data?.templates.find(g => g.id === draft.base!.id) : null;
  const draftStale = !!draft?.base && (!draftCurrent || draftCurrent.revision !== draft.base.revision);
  return {
    state, attempt, draft, draftCurrent, draftStale, settled,
    canStart: options.enabled && settled && !!data?.cloudEnabled && !readFailed,
    matches, prepare, prepareSave, confirm,
    edit(graphic?: Graphic) {
      if (!available() || !currentState()?.canConfigure || currentDraft()) return;
      putDraft({ token: createLocalRequestUuid(), content: graphic ? { name: graphic.name, title: graphic.title, subtitle: graphic.subtitle } : { name: "", title: "", subtitle: "" }, base: graphic ? { id: graphic.id, revision: graphic.revision } : null });
    },
    change(content: GraphicText) {
      const edit = currentDraft();
      if (edit && isSettled() && requests.isActive()) putDraft({ ...edit, token: createLocalRequestUuid(), content, commandId: undefined });
    },
    discard() { if (isSettled()) putDraft(undefined); },
    rebase() {
      const edit = currentDraft(), current = currentState()?.templates.find(g => g.id === edit?.base?.id);
      if (edit && current && available()) putDraft({ ...edit, token: createLocalRequestUuid(), base: { id: current.id, revision: current.revision }, commandId: undefined });
    },
    retry: () => requests.retry("graphics"), review: () => requests.review("graphics"),
    refresh: () => requests.refresh("graphics"), dismiss: () => requests.dismiss("graphics"),
  };
}
