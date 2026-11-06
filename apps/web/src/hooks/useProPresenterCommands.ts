import { useCallback, useEffect, useRef, useState } from "react";
import { sendProPresenterCommand, setProPresenterStageDisplay } from "@/lib/rundown";

export type ProPresenterOperation = { kind: "slide"; command: "previous" | "next" | "clear" } | { kind: "output"; enabled: boolean };
class UnconfirmedOperation extends Error {}
interface Failure { message: string; occurredAt: number }
interface ConfirmationState { scope: string; pending: ProPresenterOperation | null; failure: Failure | null; notice: string | null }
interface PendingOperation { scope: string; controller: AbortController; deadline?: ReturnType<typeof setTimeout> }
const initialState = (scope: string): ConfirmationState => ({ scope, pending: null, failure: null, notice: null });
const operationName = (operation: ProPresenterOperation) => operation.kind === "output" ? "Kiosk output change" : operation.command === "clear" ? "Clear slide" : operation.command === "next" ? "Next slide" : "Previous slide";

/** Confirmation only: an uncertain live command is never automatically repeated. */
export function useProPresenterCommands(options: { orgId: string; scope: string; canControlSlides: boolean; canChangeOutput: boolean }) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState(() => initialState(options.scope));
  const request = useRef<PendingOperation | null>(null);
  const reviewRequired = useRef<string | null>(null);
  useEffect(() => {
    setState(initialState(options.scope));
    reviewRequired.current = null;
    return () => {
      const current = request.current;
      request.current = null;
      if (current?.deadline !== undefined) clearTimeout(current.deadline);
      current?.controller.abort();
    };
  }, [options.scope]);

  const run = useCallback(async (operation: ProPresenterOperation) => {
    const currentOptions = latest.current;
    if (request.current || reviewRequired.current === currentOptions.scope) return;
    if (operation.kind === "slide" ? !currentOptions.canControlSlides : !currentOptions.canChangeOutput) return;
    const current: PendingOperation = { scope: currentOptions.scope, controller: new AbortController() };
    request.current = current;
    setState({ scope: current.scope, pending: operation, failure: null, notice: null });
    try {
      // A new device connection can take 8s and its command acknowledgement 10s.
      const result = await Promise.race([
        operation.kind === "slide"
          ? sendProPresenterCommand({ data: { orgId: currentOptions.orgId, command: operation.command }, signal: current.controller.signal })
          : setProPresenterStageDisplay({ data: { orgId: currentOptions.orgId, enabled: operation.enabled }, signal: current.controller.signal }),
        new Promise<never>((_resolve, reject) => {
          current.deadline = setTimeout(() => { current.controller.abort(); reject(new UnconfirmedOperation("Confirmation timed out")); }, 20_000);
        }),
      ]);
      if (request.current !== current || latest.current.scope !== current.scope) return;
      if (result?.ok !== true) throw new UnconfirmedOperation(result && "error" in result && typeof result.error === "string" ? result.error : "No acknowledgement received");
      setState({ scope: current.scope, pending: null, failure: null, notice: `${operationName(operation)} confirmed.` });
    } catch (cause) {
      if (request.current !== current || latest.current.scope !== current.scope) return;
      reviewRequired.current = current.scope;
      const detail = cause instanceof UnconfirmedOperation ? ` ${cause.message}` : "";
      setState({ scope: current.scope, pending: null, notice: null, failure: {
        occurredAt: Date.now(),
        message: `${operationName(operation)} was not confirmed.${detail} Check ProPresenter and the kiosk before sending another action.`,
      } });
    } finally {
      if (current.deadline !== undefined) clearTimeout(current.deadline);
      if (request.current === current) request.current = null;
    }
  }, []);
  const acknowledgeReview = useCallback(() => {
    if (request.current || reviewRequired.current !== latest.current.scope) return;
    reviewRequired.current = null;
    setState(initialState(latest.current.scope));
  }, []);
  return { ...(state.scope === options.scope ? state : initialState(options.scope)), run, acknowledgeReview };
}
