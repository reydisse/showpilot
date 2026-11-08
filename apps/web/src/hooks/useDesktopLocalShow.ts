import { useCallback, useEffect, useRef, useState } from "react";
import { useDesktopRuntime } from "./useDesktopRuntime";
import {
  readDesktopLocalShow,
  type DesktopLocalShowStatus,
} from "@/lib/desktop-local-show";

/** Never overlap native reads or let an old poll replace a mutation's receipt. */
export function useDesktopLocalShow(paused = false) {
  const [status, setStatus] = useState<DesktopLocalShowStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const pending = useRef(false);
  const desktop = useDesktopRuntime();
  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  useEffect(() => {
    if (!desktop || paused) return;
    let active = true;
    const poll = async () => {
      if (pending.current || document.hidden) return;
      pending.current = true;
      try {
        const next = await readDesktopLocalShow();
        if (active) {
          setStatus(next);
          setError(null);
        }
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Local show status unavailable. Refresh to try again.",
          );
      } finally {
        pending.current = false;
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [desktop, paused, refreshKey]);
  return { desktop, status, error, refresh };
}
