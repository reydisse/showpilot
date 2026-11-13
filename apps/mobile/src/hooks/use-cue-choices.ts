import { useQuery } from "@tanstack/react-query";
import { runMobileOperation } from "../lib/request-deadline";
export function useCueChoices<T>(key: readonly string[], load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  return useQuery({ queryKey: ["mobile-cue-choices", ...key], queryFn: ({ signal }) => runMobileOperation(controller => load(controller.signal), signal, 10000), enabled, retry: false });
}
