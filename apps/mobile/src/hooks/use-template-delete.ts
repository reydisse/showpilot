import {
  useRetainedDraftList,
  useRetainedRequests,
  type RetainedAttempt,
} from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  templateDeleteReplySchema,
  type TemplateDeleteCommand,
  type TemplateDeleteReply,
} from "../lib/template-delete-recovery";

export function useTemplateDelete(
  scope: { orgId: string; userId: string; showId: string },
  options: {
    active: boolean;
    send: (
      command: TemplateDeleteCommand,
      signal: AbortSignal,
    ) => Promise<TemplateDeleteReply>;
    refresh: (signal: AbortSignal) => Promise<void>;
  },
) {
  const requests = useRetainedRequests(scope, {
    family: "mobile-template-delete-request",
    scopeKey: scope.showId,
    enabled: options.active,
    slot: (command: TemplateDeleteCommand) => command.templateId,
    send: async (command, signal) => {
      const result = templateDeleteReplySchema.parse(
        await options.send(command, signal),
      );
      if (
        result.showId !== command.showId ||
        result.templateId !== command.templateId
      )
        throw new Error("The deletion reply belongs to another template.");
      return result;
    },
    parseResult: (value) => templateDeleteReplySchema.parse(value),
    retryable: () => false,
    dismissible: () => true,
    failureMessage:
      "Deletion could not be confirmed. It may have completed. Retry the same deletion to confirm its outcome.",
    refresh: options.refresh,
  });
  return {
    ...requests,
    confirm: (template: { id: string; name: string }) => {
      if (!requests.isActive() || requests.work[template.id]) return;
      requests.start(
        {
          ...scope,
          templateId: template.id,
          requestId: createLocalRequestUuid(),
        },
        template.name,
      );
    },
  };
}

export function useTemplateDeleteAttempts(scope: {
  orgId: string;
  userId: string;
  showId: string;
}) {
  return useRetainedDraftList<
    Record<string, RetainedAttempt<TemplateDeleteCommand, TemplateDeleteReply>>
  >("mobile-template-delete-request", scope)
    .flatMap((work) => Object.values(work))
    .filter((attempt) => attempt.command.showId === scope.showId);
}
