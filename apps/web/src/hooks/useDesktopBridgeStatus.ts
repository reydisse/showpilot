import { useEffect, useRef, useState } from "react";
import { getDesktopBridgeStatus, type DesktopBridgeStatus } from "@/lib/desktop-runtime";

/** Poll again only after the preceding native read settles. An explicit refresh
 * invalidates that read, so late status cannot overwrite a newer mode change. */
export function useDesktopBridgeStatus(enabled: boolean) {
  const [status, setStatus] = useState<DesktopBridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useRef(() => {});
  useEffect(() => {
    if (!enabled) return;
    let active = true, generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (!active) return;
      const owner = ++generation;
      clearTimeout(timer); clearTimeout(deadline);
      deadline = setTimeout(() => { if (active && owner === generation) setError("The local engine has not returned its device status. You can retry this read."); }, 12000);
      void Promise.resolve().then(getDesktopBridgeStatus).then(value => {
        if (active && owner === generation) { setStatus(value); setError(null); }
      }, cause => {
        if (active && owner === generation) setError(cause instanceof Error ? cause.message : "Local device status unavailable");
      }).finally(() => {
        if (!active || owner !== generation) return;
        clearTimeout(deadline);
        timer = setTimeout(read, 5000);
      });
    };
    refresh.current = read;
    read();
    return () => { active = false; ++generation; clearTimeout(timer); clearTimeout(deadline); refresh.current = () => {}; };
  }, [enabled]);
  return { status, error, refresh: () => refresh.current() };
}
