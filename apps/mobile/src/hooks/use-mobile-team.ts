import { useCallback, useState, useSyncExternalStore } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRetainedRequests,
  useRetainedDraftList,
  type RetainedAttempt,
} from "./use-retained-requests";
import {
  saveTeamRows,
  teamCommandSchema,
  teamResultSchema,
  teamRetryable,
  type TeamCommand,
  type TeamDraft,
  type TeamResult,
} from "../lib/team-recovery";
import type {
  ScheduleAssignmentCommand,
  ScheduleAssignmentResult,
} from "../lib/assignment-recovery";
import { createLocalRequestUuid } from "../lib/request-id";

type Work = Record<string, RetainedAttempt<TeamCommand, TeamResult>>;
export function useMobileTeam(
  scope: { orgId: string; userId: string },
  initial: TeamDraft,
  options: {
    active: boolean;
    send: (
      command: ScheduleAssignmentCommand,
      review: boolean,
      signal: AbortSignal,
    ) => Promise<ScheduleAssignmentResult>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const client = useQueryClient();
  const key = ["mobile-team-draft", scope.userId, scope.orgId, initial.showId],
    hash = hashKey(key);
  const requestKey = [
    "mobile-team-request",
    scope.userId,
    scope.orgId,
    initial.showId,
  ];
  useQuery({
    queryKey: key,
    queryFn: () => initial,
    initialData: initial,
    enabled: false,
    gcTime: Infinity,
  });
  const cached = () => client.getQueryData<TeamDraft>(key);
  const draft = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    () => cached() ?? initial,
    () => cached() ?? initial,
  );
  const currentAttempt = () => client.getQueryData<Work>(requestKey)?.team;
  function send(command: TeamCommand, signal: AbortSignal, review = false) {
    const attempt = currentAttempt();
    const previous =
      attempt?.kind === "confirmed"
        ? attempt.result
        : (attempt?.previous ?? null);
    return saveTeamRows(command, previous, options.send, review, signal);
  }
  const requests = useRetainedRequests(scope, {
    family: "mobile-team-request",
    scopeKey: initial.showId,
    enabled: options.active,
    slot: () => "team",
    send,
    review: (command, signal) => send(command, signal, true),
    parseResult: (input) => teamResultSchema.parse(input),
    retryable: teamRetryable,
    dismissible: (result) => !teamRetryable(result),
    failureMessage: "The team save could not be confirmed.",
    refresh: options.refresh,
  });
  const [error, setError] = useState("");
  function setDraft(update: (value: TeamDraft) => TeamDraft) {
    if (!requests.isActive() || currentAttempt()) return;
    client.setQueryData<TeamDraft>(key, (value) =>
      value ? update(value) : value,
    );
    setError("");
  }
  function submit() {
    const value = cached();
    if (!requests.isActive() || currentAttempt() || !value) return;
    const parsed = teamCommandSchema.safeParse({
      ...scope,
      requestId: createLocalRequestUuid(),
      rows: value.rows.map((row) => ({
        name: row.name,
        command: {
          ...scope,
          requestId: createLocalRequestUuid(),
          operation: {
            kind: "create",
            fields: {
              showId: value.showId,
              serviceDate: value.serviceDate,
              timeZone: value.timeZone,
              role: row.role,
              department: value.department,
              crewMemberId: row.crewMemberId,
              notes: "",
              callTime: "",
            },
          },
        },
      })),
    });
    if (!parsed.success) {
      setError(
        "Choose 1–50 people and enter a department and role for each person.",
      );
      return;
    }
    requests.start(
      parsed.data,
      `${value.department} · ${value.showName} (${value.serviceDate})`,
    );
  }
  function editUnapplied() {
    const attempt = currentAttempt(),
      before = cached();
    if (
      !requests.isActive() ||
      !before ||
      attempt?.kind !== "confirmed" ||
      attempt.refresh !== "done" ||
      teamRetryable(attempt.result)
    )
      return;
    const unapplied = new Set(
      attempt.result.rows
        .filter((row) => row.result?.outcome === "conflict")
        .map((row) => row.requestId),
    );
    const selected = new Set(
      attempt.command.rows
        .filter((row) => unapplied.has(row.command.requestId))
        .flatMap((row) =>
          row.command.operation.kind === "create"
            ? [row.command.operation.fields.crewMemberId]
            : [],
        ),
    );
    if (!selected.size) return;
    requests.dismiss("team");
    client.setQueryData<TeamDraft>(key, (value) =>
      value === before
        ? {
            ...value,
            rows: value.rows.filter((row) => selected.has(row.crewMemberId)),
          }
        : value,
    );
  }
  function close(discard: boolean) {
    const attempt = currentAttempt();
    if (
      !requests.isActive() ||
      (discard
        ? !!attempt
        : !attempt ||
          attempt.kind !== "confirmed" ||
          attempt.refresh !== "done" ||
          teamRetryable(attempt.result))
    )
      return false;
    if (attempt) requests.dismiss("team");
    client.removeQueries({ queryKey: key, exact: true });
    client.removeQueries({ queryKey: requestKey, exact: true });
    return true;
  }
  return {
    draft,
    attempt: requests.work.team,
    error,
    setDraft,
    submit,
    editUnapplied,
    retry: () => requests.retry("team"),
    review: () => requests.review("team"),
    refresh: () => requests.refresh("team"),
    finish: () => close(false),
    discard: () => close(true),
  };
}

export function useTeamDrafts(scope: { orgId: string; userId: string }) {
  return useRetainedDraftList<TeamDraft>("mobile-team-draft", scope);
}
