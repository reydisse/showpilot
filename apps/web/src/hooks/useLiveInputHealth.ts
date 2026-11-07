import { useCallback, useMemo } from "react";
import { getLiveInputStatus } from "@/lib/stream";
import { useOperatorRead } from "./useOperatorRead";

type InputHealth = NonNullable<Awaited<ReturnType<typeof getLiveInputStatus>>>;
export function useLiveInputHealth(orgId: string, inputs: readonly { id: string; setupState?: string }[]) {
  const key = JSON.stringify([orgId, inputs.map(input => [input.id, input.setupState])]);
  const ids = useMemo(() => inputs.map(input => input.id), [key]);
  const read = useCallback(async (signal: AbortSignal) => {
    const results = await Promise.all(ids.map(async inputId => {
      try {
        return await getLiveInputStatus({ data: { orgId, inputId }, signal }) ?? {
          inputId, status: "unknown", providerStatus: "missing", checkedAt: new Date().toISOString(), error: "This input was removed. Refresh the input list.",
        } satisfies InputHealth;
      } catch {
        return { inputId, status: "unknown", providerStatus: "unconfirmed", checkedAt: new Date().toISOString(), error: "Input health could not be checked. Retry the check." } satisfies InputHealth;
      }
    }));
    return Object.fromEntries(results.map(result => [result.inputId, result]));
  }, [orgId, ids]);
  const result = useOperatorRead<Record<string, InputHealth>>({ key, initialValue: {}, read, enabled: ids.length > 0, intervalMs: 10_000, errorMessage: "Input health could not be refreshed. Last confirmed values are retained; current health is unknown." });
  const unknownCount = ids.filter(id => !result.value[id] || result.value[id].status === "unknown").length;
  const failure = result.error ?? (unknownCount > 0 && result.confirmedAt !== null ? {
    message: `${unknownCount} input${unknownCount === 1 ? "" : "s"} could not be confirmed. Review setup or retry health.`, occurredAt: result.confirmedAt,
  } : null);
  return { ...result, failure, unknownCount: result.error ? ids.length : unknownCount };
}
