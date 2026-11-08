import { useCallback, useEffect, useRef, useState } from "react";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import type {
  NotificationCountState,
  startNotificationCount,
} from "@/lib/account-notification-count";

const empty: NotificationCountState = { kind: "loading", snapshot: null };
type Controller = ReturnType<typeof startNotificationCount>;

export function useAccountNotificationCount(orgId: string, userId: string) {
  const key = JSON.stringify([orgId, userId]);
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<{
    key: string;
    state: NotificationCountState;
  }>({ key, state: empty });
  const current = useRef<{ key: string; controller: Controller } | null>(null);
  useEffect(() => {
    let active = true;
    setValue({ key, state: empty });
    void runRouteLoad(
      () => import("@/lib/account-notification-count"),
      undefined,
      8_000,
    ).then(
      (module) => {
        if (!active) return;
        current.current = {
          key,
          controller: module.startNotificationCount(orgId, (state) => {
            if (active) setValue({ key, state });
          }),
        };
      },
      () => {
        if (active)
          setValue({
            key,
            state: {
              kind: "failed",
              snapshot: null,
              occurredAt: Date.now(),
              retrying: false,
            },
          });
      },
    );
    return () => {
      active = false;
      current.current?.controller.dispose();
      current.current = null;
    };
  }, [key, orgId, attempt]);
  const retry = useCallback(() => {
    if (current.current?.key === key) current.current.controller.retry();
    else setAttempt((value) => value + 1);
  }, [key]);
  const accept = useCallback(
    (unread: number) => {
      if (current.current?.key === key)
        current.current.controller.accept(unread);
    },
    [key],
  );
  return { state: value.key === key ? value.state : empty, retry, accept };
}
