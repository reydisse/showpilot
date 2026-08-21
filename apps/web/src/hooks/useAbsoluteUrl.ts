import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Return an absolute URL after hydration while keeping the server and the
 * client's first render identical.
 */
export function useAbsoluteUrl(path: string) {
  const origin = useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => "",
  );

  return `${origin}${path}`;
}
