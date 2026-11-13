import { useEffect, useMemo, useRef } from "react";
import { useRetainedRequests } from "./use-retained-requests";
import { createLocalRequestUuid } from "../lib/request-id";
import {
  proPresenterReplySchema,
  type ProPresenterCommand,
  type ProPresenterReply,
} from "../lib/propresenter-command";

type Scope = Pick<ProPresenterCommand, "orgId" | "userId" | "showId">;
export function useProPresenterCommand(
  scope: Scope,
  options: {
    enabled: boolean;
    ready: boolean;
    call: (
      command: ProPresenterCommand,
      mode: "prepare" | "execute" | "check",
      signal: AbortSignal,
    ) => Promise<ProPresenterReply>;
  },
) {
  const owner = useMemo(
    () => ({ mounted: false }),
    // A new owner invalidates late preparation replies after scope/access changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope.orgId, scope.userId, scope.showId, options.enabled],
  );
  const current = useRef({ owner, ready: options.ready });
  current.current = { owner, ready: options.ready };
  useEffect(() => {
    owner.mounted = options.enabled;
    return () => {
      owner.mounted = false;
    };
  }, [owner, options.enabled]);
  const active = () => owner.mounted && current.current.owner === owner;
  async function call(
    command: ProPresenterCommand,
    mode: "prepare" | "execute" | "check",
    signal: AbortSignal,
  ) {
    const reply = proPresenterReplySchema.parse(
      await options.call(command, mode, signal),
    );
    if (
      reply.requestId !== command.requestId ||
      reply.orgId !== command.orgId ||
      reply.userId !== command.userId ||
      reply.showId !== command.showId ||
      reply.command !== command.command
    )
      throw new Error("The reply belongs to another slide command.");
    return reply;
  }
  const requests = useRetainedRequests<ProPresenterCommand, ProPresenterReply>(
    scope,
    {
      family: "mobile-propresenter-command",
      scopeKey: scope.showId,
      enabled: options.enabled,
      slot: () => "slide",
      parseResult: proPresenterReplySchema.parse,
      send: async (command, signal) => {
        const prepared = await call(command, "prepare", signal);
        if (
          prepared.status !== "prepared" ||
          signal.aborted ||
          !active() ||
          !current.current.ready
        )
          return prepared;
        return call(command, "execute", signal);
      },
      review: (command, signal) => call(command, "check", signal),
      retryable: (result) =>
        result.status !== "confirmed" && result.status !== "rejected",
      dismissible: (result) =>
        result.status === "confirmed" ||
        result.status === "rejected" ||
        result.status === "uncertain",
      failureMessage:
        "The command could not be confirmed. Check its status and the ProPresenter output before sending another.",
      refresh: async () => {},
    },
  );
  const attempt = requests.work.slide;
  const canStart =
    options.enabled &&
    options.ready &&
    (!attempt ||
      (attempt.kind === "confirmed" &&
        attempt.refresh === "done" &&
        attempt.result.status === "confirmed"));
  return {
    attempt,
    canStart,
    start(command: ProPresenterCommand["command"]) {
      if (!active() || !canStart || !requests.isActive()) return;
      if (attempt) requests.dismiss("slide");
      requests.start(
        { ...scope, command, requestId: createLocalRequestUuid() },
        command === "next"
          ? "Next slide"
          : command === "previous"
            ? "Previous slide"
            : "Clear ProPresenter output",
      );
    },
    check: () => requests.review("slide"),
    acknowledge: () => requests.dismiss("slide"),
  };
}
