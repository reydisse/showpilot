import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRetainedRequests } from "./use-retained-requests";
import { runMobileOperation } from "../lib/request-deadline";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  proPresenterOutputResultSchema,
  proPresenterOutputSnapshotSchema,
  type ProPresenterOutputCommand,
  type ProPresenterOutputSnapshot,
  type ProPresenterOutputResult,
} from "@showpilot/shared/propresenter-output";

type Scope = { orgId: string; userId: string };
type Review = Scope & { enabled: boolean; expectedRevision: string | null };
export function useProPresenterOutput(
  scope: Scope,
  options: {
    enabled: boolean;
    read: (
      orgId: string,
      signal: AbortSignal,
    ) => Promise<ProPresenterOutputSnapshot>;
    send: (
      command: ProPresenterOutputCommand,
      signal: AbortSignal,
    ) => Promise<ProPresenterOutputResult>;
  },
) {
  const client = useQueryClient();
  const queryKey = [
    "mobile-propresenter-output-state",
    scope.userId,
    scope.orgId,
  ];
  const read = (signal: AbortSignal) =>
    runMobileOperation(
      async (controller) =>
        proPresenterOutputSnapshotSchema.parse(
          await options.read(scope.orgId, controller.signal),
        ),
      signal,
      8_000,
    );
  const pollingInterval = (query: { state: { status: string } }) =>
    options.enabled && query.state.status !== "error" ? 5_000 : false;
  const state = useQuery<ProPresenterOutputSnapshot>({
    queryKey,
    enabled: options.enabled,
    retry: false,
    networkMode: "always",
    refetchInterval: pollingInterval,
    queryFn: ({ signal }) => read(signal),
  });
  const requests = useRetainedRequests<
    ProPresenterOutputCommand,
    ProPresenterOutputResult
  >(scope, {
    family: "mobile-propresenter-output-command",
    enabled: options.enabled,
    slot: () => "output",
    send: async (command, signal) => {
      const result = proPresenterOutputResultSchema.parse(
        await options.send(command, signal),
      );
      if (
        result.enabled !== command.enabled ||
        result.expectedRevision !== command.expectedRevision ||
        result.expiresAt !== command.expiresAt
      )
        throw new Error("The reply belongs to a different output change.");
      return result;
    },
    parseResult: proPresenterOutputResultSchema.parse,
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "The output change was not confirmed. Retry the original request to recover its result.",
    refreshFailureMessage:
      "The command result is saved, but current output state could not refresh. Retry the read.",
    refresh: async (signal) => {
      await client.cancelQueries({ queryKey, exact: true });
      await client.fetchQuery({
        queryKey,
        staleTime: 0,
        queryFn: () => read(signal),
      });
    },
  });
  const attempt = requests.work.output;
  const readFailed = state.isError;
  const canStart =
    options.enabled &&
    !!state.data &&
    !readFailed &&
    (!attempt ||
      (attempt.kind === "confirmed" &&
        attempt.refresh === "done" &&
        attempt.result.outcome === "applied"));
  function matches(review: Review) {
    const current = client.getQueryData<ProPresenterOutputSnapshot>(queryKey);
    return (
      canStart &&
      review.orgId === scope.orgId &&
      review.userId === scope.userId &&
      !!current &&
      client.getQueryState(queryKey)?.status !== "error" &&
      review.expectedRevision === current.revision &&
      review.enabled !== current.enabled
    );
  }
  return {
    state,
    attempt,
    canStart,
    prepare(): Review | null {
      return canStart && state.data
        ? {
            ...scope,
            enabled: !state.data.enabled,
            expectedRevision: state.data.revision,
          }
        : null;
    },
    matches,
    confirm(review: Review) {
      if (!matches(review) || !requests.isActive() || !state.data) return;
      if (attempt) requests.dismiss("output");
      requests.start(
        {
          ...review,
          requestId: createLocalRequestUuid(),
          expiresAt:
            state.data.serverTime +
            Math.max(0, Date.now() - state.dataUpdatedAt) +
            5_000,
        },
        review.enabled
          ? "Show ProPresenter slides on stage displays"
          : "Hide ProPresenter slides from stage displays",
      );
    },
    retry: () => requests.retry("output"),
    refresh: () => requests.refresh("output"),
    dismiss: () => requests.dismiss("output"),
  };
}
