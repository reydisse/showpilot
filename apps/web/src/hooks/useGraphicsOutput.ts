import { useCallback, useEffect, useRef, useState } from "react";
import { addActiveGraphic, removeActiveGraphic, clearActiveGraphics, getActiveGraphics, publishGraphicComposition, type GraphicCompositionItem } from "@/lib/graphics";
import { useOperatorRead, type OperatorReadFailure } from "./useOperatorRead";

export type GraphicsOutputOperation = { kind: "show" | "hide"; graphicId: string } | { kind: "clear" } | { kind: "publish"; requestId: string; items: GraphicCompositionItem[] };
interface OutputControl {
  orgId: string;
  generation: number;
  seed: { ids: string[]; confirmed: boolean };
  pending: GraphicsOutputOperation | null;
  failure: OperatorReadFailure | null;
}
interface PendingWrite { controller: AbortController; deadline?: ReturnType<typeof setTimeout> }
const initialControl = (orgId: string, ids: string[]): OutputControl => ({ orgId, generation: 0, seed: { ids, confirmed: true }, pending: null, failure: null });

/** Serialize local writes with reads; uncertain writes are reconciled, never replayed. */
export function useGraphicsOutput(orgId: string, initialIds: string[], canTrigger: boolean) {
  const [control, setControl] = useState(() => initialControl(orgId, initialIds));
  const pendingWrite = useRef<PendingWrite | null>(null);
  const current = control.orgId === orgId ? control : initialControl(orgId, initialIds);
  const output = useOperatorRead({
    key: JSON.stringify([orgId, current.generation]),
    initialValue: current.seed,
    enabled: current.pending === null,
    intervalMs: 2000,
    read: useCallback(async (signal: AbortSignal) => ({ ids: (await getActiveGraphics({ data: { orgId }, signal })).map(graphic => graphic.id), confirmed: true }), [orgId]),
    errorMessage: "Graphics output could not refresh. Showing the last confirmed on-air state.",
  });
  const latest = useRef({ orgId, canTrigger, output });
  latest.current = { orgId, canTrigger, output };
  useEffect(() => {
    setControl(previous => previous.orgId === orgId ? previous : initialControl(orgId, initialIds));
    return () => {
      const pending = pendingWrite.current;
      pendingWrite.current = null;
      if (pending?.deadline !== undefined) clearTimeout(pending.deadline);
      pending?.controller.abort();
    };
    // Loader changes must not overwrite a newer confirmed output snapshot.
  }, [orgId]);

  const run = useCallback(async (operation: GraphicsOutputOperation): Promise<boolean> => {
    const context = latest.current;
    if (pendingWrite.current || !context.canTrigger) return false;
    // Clear remains available as an explicit stop-all action, even with stale reads.
    if (operation.kind !== "clear" && (context.output.error || !context.output.value.confirmed)) return false;
    const pending: PendingWrite = { controller: new AbortController() };
    pendingWrite.current = pending;
    const seed = { ids: context.output.value.ids, confirmed: false };
    setControl(previous => ({ orgId: context.orgId, generation: previous.generation + 1, seed, pending: operation, failure: null }));
    try {
      let superseded = false;
      const send = async () => {
        const signal = pending.controller.signal;
        if (operation.kind === "publish") {
          const result = await publishGraphicComposition({ data: { orgId: context.orgId, requestId: operation.requestId, items: operation.items }, signal });
          if (result?.revision !== operation.requestId || typeof result.isActive !== "boolean") throw new Error("Missing publication acknowledgement");
          superseded = !result.isActive;
          return result.activeIds;
        }
        if (operation.kind === "clear") return clearActiveGraphics({ data: { orgId: context.orgId }, signal });
        const args = { data: { orgId: context.orgId, graphicId: operation.graphicId }, signal };
        return operation.kind === "show" ? addActiveGraphic(args) : removeActiveGraphic(args);
      };
      const ids = await Promise.race([
        send(),
        new Promise<never>((_resolve, reject) => {
          pending.deadline = setTimeout(() => { pending.controller.abort(); reject(new Error("Graphics confirmation timed out")); }, 10_000);
        }),
      ]);
      if (pendingWrite.current !== pending || latest.current.orgId !== context.orgId) return false;
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string")) throw new Error("Missing output acknowledgement");
      setControl(previous => ({ orgId: context.orgId, generation: previous.generation + 1, seed: { ids, confirmed: true }, pending: null, failure: superseded ? {
        message: "A newer Program change is active. Your publication will not be repeated. Review the current output before another action.", occurredAt: Date.now(),
      } : null }));
      return !superseded;
    } catch {
      if (pendingWrite.current !== pending || latest.current.orgId !== context.orgId) return false;
      setControl(previous => ({ orgId: context.orgId, generation: previous.generation + 1, seed, pending: null, failure: {
        message: "Graphics change was not confirmed. Check the refreshed output before choosing another action. The change will not be repeated automatically.",
        occurredAt: Date.now(),
      } }));
      return false;
    } finally {
      if (pending.deadline !== undefined) clearTimeout(pending.deadline);
      if (pendingWrite.current === pending) pendingWrite.current = null;
    }
  }, []);
  return { activeIds: output.value.ids, fresh: output.value.confirmed && !output.error && current.pending === null,
    pending: current.pending, failure: current.failure, readFailure: output.error, refreshing: output.refreshing, retry: output.retry, run };
}
