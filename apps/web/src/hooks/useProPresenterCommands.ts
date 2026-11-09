import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  proPresenterReplySchema,
  type ProPresenterCommand,
  type ProPresenterReply,
} from "@showpilot/shared/propresenter-command";
import {
  sendProPresenterCommand,
  setProPresenterStageDisplay,
} from "@/lib/rundown";
import { runRouteLoad } from "@/lib/route-load-deadlines";

export type ProPresenterOperation =
  | { kind: "slide"; command: "previous" | "next" | "clear" }
  | { kind: "output"; enabled: boolean };
type SlideAttempt = {
  kind: "slide";
  command: ProPresenterCommand;
  at: number;
  viewScope: string;
} & (
  | { phase: "pending" | "checking" }
  | { phase: "unknown"; message: string }
  | { phase: "result"; result: ProPresenterReply }
);
type OutputAttempt = {
  kind: "output";
  enabled: boolean;
  at: number;
  viewScope: string;
} & (
  | { phase: "pending" | "confirmed" }
  | { phase: "unknown"; message: string }
);
type Attempt = SlideAttempt | OutputAttempt;
const operationName = (attempt: Attempt) =>
  attempt.kind === "output"
    ? "Kiosk output change"
    : attempt.command.command === "clear"
      ? "Clear slide"
      : attempt.command.command === "next"
        ? "Next slide"
        : "Previous slide";
const isPending = (attempt: Attempt | null) =>
  attempt?.phase === "pending" || attempt?.phase === "checking";
const confirmed = (attempt: Attempt | null) =>
  attempt?.phase === "confirmed" ||
  (attempt?.phase === "result" && attempt.result.status === "confirmed");

/** One retained operator request per workspace. Navigating away, changing show,
 * or changing the configured target must not erase an uncertain hardware action. */
export function useProPresenterCommands(options: {
  orgId: string;
  userId: string;
  showId: string | null;
  scope: string;
  canControlSlides: boolean;
  canCheckSlides: boolean;
  canChangeOutput: boolean;
}) {
  const client = useQueryClient();
  const key = ["web-propresenter-command", options.userId, options.orgId],
    hash = hashKey(key);
  useQuery({
    queryKey: key,
    queryFn: () => null,
    initialData: null,
    enabled: false,
    gcTime: Infinity,
  });
  const read = () => client.getQueryData<Attempt | null>(key) ?? null;
  const attempt = useSyncExternalStore(
    useCallback(
      (notify) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryHash === hash) notify();
        }),
      [client, hash],
    ),
    read,
    () => null,
  );
  // This token represents the viewed scope, not the cached request's lifetime.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const owner = useMemo(() => ({ mounted: false }), [hash, options.scope]);
  const latest = useRef({ options, owner });
  latest.current = { options, owner };
  useEffect(() => {
    owner.mounted = true;
    return () => {
      owner.mounted = false;
    };
  }, [owner]);
  const active = () => owner.mounted && latest.current.owner === owner;
  const put = (before: Attempt | null, after: Attempt | null) =>
    client.setQueryData<Attempt | null>(key, (current) =>
      current === before ? after : current,
    );
  async function slideCall(
    command: ProPresenterCommand,
    mode: "prepare" | "execute" | "check",
    signal: AbortSignal,
  ) {
    const result = proPresenterReplySchema.parse(
      await sendProPresenterCommand({ data: { ...command, mode }, signal }),
    );
    if (
      result.orgId !== command.orgId ||
      result.userId !== command.userId ||
      result.showId !== command.showId ||
      result.requestId !== command.requestId ||
      result.command !== command.command
    )
      throw new Error("Reply does not match the original slide command.");
    return result;
  }
  async function run(operation: ProPresenterOperation) {
    const previous = read(),
      currentOptions = latest.current.options;
    if (!active() || (previous && !confirmed(previous))) return;
    if (
      operation.kind === "slide"
        ? !currentOptions.canControlSlides || !currentOptions.showId
        : !currentOptions.canChangeOutput
    )
      return;
    const command =
      operation.kind === "slide" && currentOptions.showId
        ? {
            orgId: currentOptions.orgId,
            userId: currentOptions.userId,
            showId: currentOptions.showId,
            requestId: crypto.randomUUID(),
            command: operation.command,
          }
        : null;
    const next: Attempt = command
      ? {
          kind: "slide",
          command,
          viewScope: currentOptions.scope,
          phase: "pending",
          at: Date.now(),
        }
      : {
          kind: "output",
          enabled: operation.kind === "output" && operation.enabled,
          viewScope: currentOptions.scope,
          phase: "pending",
          at: Date.now(),
        };
    const claim = put(previous, next);
    if (!claim) return;
    try {
      const result = await runRouteLoad(
        async (controller) => {
          if (command) {
            const prepared = await slideCall(
              command,
              "prepare",
              controller.signal,
            );
            if (
              prepared.status !== "prepared" ||
              controller.signal.aborted ||
              !active() ||
              !latest.current.options.canControlSlides
            )
              return prepared;
            return slideCall(command, "execute", controller.signal);
          }
          if (next.kind !== "output") throw new Error("Missing output action.");
          const output = await setProPresenterStageDisplay({
            data: { orgId: currentOptions.orgId, enabled: next.enabled },
            signal: controller.signal,
          });
          if (output?.ok !== true)
            throw new Error("No output acknowledgement.");
          return null;
        },
        undefined,
        20_000,
      );
      if (command && result)
        put(claim, {
          kind: "slide",
          command,
          viewScope: currentOptions.scope,
          phase: "result",
          result,
          at: Date.now(),
        });
      else if (next.kind === "output")
        put(claim, { ...next, phase: "confirmed", at: Date.now() });
    } catch {
      put(claim, {
        ...next,
        phase: "unknown",
        at: Date.now(),
        message: `${operationName(next)} was not confirmed. ${next.kind === "slide" ? "Check the original command status before sending another action." : "Check ProPresenter and the kiosk before sending another action."}`,
      });
    }
  }
  async function checkStatus() {
    const previous = read();
    if (
      !active() ||
      !latest.current.options.canCheckSlides ||
      !previous ||
      previous.kind !== "slide" ||
      isPending(previous) ||
      confirmed(previous)
    )
      return;
    const next: SlideAttempt = {
      kind: "slide",
      command: previous.command,
      viewScope: previous.viewScope,
      phase: "checking",
      at: previous.at,
    };
    const claim = put(previous, next);
    if (!claim) return;
    try {
      const result = await runRouteLoad(
        (controller) => slideCall(previous.command, "check", controller.signal),
        undefined,
        12_000,
      );
      put(claim, {
        kind: "slide",
        command: previous.command,
        viewScope: previous.viewScope,
        phase: "result",
        result,
        at: Date.now(),
      });
    } catch {
      put(claim, {
        kind: "slide",
        command: previous.command,
        viewScope: previous.viewScope,
        phase: "unknown",
        at: Date.now(),
        message:
          "Command status could not be checked. Retry the status check; it does not send another slide command.",
      });
    }
  }
  const canAcknowledge = (value: Attempt | null) =>
    (value?.kind === "output" && value.phase === "unknown") ||
    (value?.phase === "result" &&
      (value.result.status === "rejected" ||
        value.result.status === "uncertain"));
  const failure =
    attempt?.phase === "unknown"
      ? { message: attempt.message, occurredAt: attempt.at }
      : attempt?.phase === "result" && attempt.result.status !== "confirmed"
        ? {
            message:
              attempt.result.status === "prepared"
                ? "The command was prepared but has not been sent. Check its status before another action."
                : attempt.result.message,
            occurredAt: attempt.at,
          }
        : null;
  return {
    previousContext: !!attempt && attempt.viewScope !== options.scope,
    pending:
      isPending(attempt) && attempt
        ? attempt.kind === "slide"
          ? { kind: "slide" as const, command: attempt.command.command }
          : { kind: "output" as const, enabled: attempt.enabled }
        : null,
    checking: attempt?.phase === "checking",
    failure,
    notice:
      attempt && confirmed(attempt)
        ? `${operationName(attempt)} confirmed.`
        : null,
    blocked: !!attempt && !confirmed(attempt),
    canCheck:
      attempt?.kind === "slide" &&
      !isPending(attempt) &&
      !confirmed(attempt) &&
      options.canCheckSlides,
    canAcknowledge: canAcknowledge(attempt),
    run,
    checkStatus,
    acknowledgeReview: () => {
      const current = read();
      if (active() && canAcknowledge(current)) put(current, null);
    },
  };
}
