import { useRetainedRequests } from "./use-retained-requests";
import {
  copyTeamCommandSchema,
  copyTeamResultSchema,
  type CopyTeamCommand,
  type CopyTeamResult,
  type CopyTeamSelection,
} from "../lib/copy-recovery";
import { createLocalRequestUuid } from "../lib/request-id";
export const copyRetryable = (result: CopyTeamResult) =>
  !result.reason &&
  result.items.some(
    (item) =>
      !item.changed &&
      item.invitation &&
      ["failed", "uncertain", "sending", "unavailable"].includes(
        item.invitation.email,
      ),
  );
export function useMobileCopy(
  scope: { orgId: string; userId: string },
  options: {
    enabled: boolean;
    send: (
      command: CopyTeamCommand,
      signal: AbortSignal,
    ) => Promise<CopyTeamResult>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const requests = useRetainedRequests(scope, {
    ...options,
    family: "mobile-schedule-copy",
    slot: (command) => command.showId,
    parseResult: (input) => copyTeamResultSchema.parse(input),
    retryable: copyRetryable,
    dismissible: (result) => !copyRetryable(result),
    failureMessage: "The team copy could not be confirmed.",
  });
  return {
    ...requests,
    start: (selection: CopyTeamSelection, label: string) =>
      requests.start(
        copyTeamCommandSchema.parse({
          ...scope,
          requestId: createLocalRequestUuid(),
          ...selection,
        }),
        label,
      ),
  };
}
