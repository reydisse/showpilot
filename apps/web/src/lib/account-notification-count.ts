import { getPersonalNotificationCount } from "./personal-notifications";
import { runRouteLoad } from "./route-load-deadlines";
import { isDesktopRuntime } from "./desktop-runtime";
import {
  PERSONAL_NOTIFICATION_COUNT_EVENT,
  readPersonalNotificationCount,
} from "./notification-events";

type Snapshot = { unread: number; confirmedAt: number };
export type NotificationCountState =
  | { kind: "loading"; snapshot: Snapshot | null }
  | { kind: "ready"; snapshot: Snapshot }
  | {
      kind: "failed";
      snapshot: Snapshot | null;
      occurredAt: number;
      retrying: boolean;
    };

/** One active read. Native count events refresh this account's scoped count;
 * a quiet native controller falls back to a read after one minute. */
export function startNotificationCount(
  orgId: string,
  publish: (state: NotificationCountState) => void,
) {
  let disposed = false;
  let pending: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: NotificationCountState = { kind: "loading", snapshot: null };
  const emit = (next: NotificationCountState) => {
    state = next;
    if (!disposed) publish(next);
  };
  const visible = () => document.visibilityState !== "hidden";
  const cancel = () => {
    clearTimeout(timer);
    const previous = pending;
    pending = null;
    previous?.abort();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!disposed && visible())
      timer = setTimeout(refresh, isDesktopRuntime() ? 60_000 : 20_000);
  };
  const refresh = () => {
    if (disposed || pending || !visible()) return;
    clearTimeout(timer);
    const current = new AbortController();
    pending = current;
    emit(
      state.kind === "failed"
        ? { ...state, retrying: true }
        : { kind: "loading", snapshot: state.snapshot },
    );
    void runRouteLoad(
      (controller) =>
        getPersonalNotificationCount({
          data: { orgId },
          signal: controller.signal,
        }),
      current.signal,
      8_000,
    )
      .then(
        (result) => {
          if (!disposed && pending === current)
            emit({
              kind: "ready",
              snapshot: { unread: result.unread, confirmedAt: Date.now() },
            });
        },
        () => {
          if (!disposed && pending === current)
            emit({
              kind: "failed",
              snapshot: state.snapshot,
              occurredAt: Date.now(),
              retrying: false,
            });
        },
      )
      .finally(() => {
        if (pending === current) {
          pending = null;
          schedule();
        }
      });
  };
  const visibility = () => {
    if (visible()) refresh();
    else {
      cancel();
      if (state.kind === "failed") emit({ ...state, retrying: false });
      else if (state.snapshot)
        emit({ kind: "ready", snapshot: state.snapshot });
    }
  };
  const countEvent = (event: Event) => {
    if (readPersonalNotificationCount(event)?.orgId === orgId) refresh();
  };
  window.addEventListener("focus", refresh);
  window.addEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, countEvent);
  document.addEventListener("visibilitychange", visibility);
  refresh();
  return {
    retry: refresh,
    accept(unread: number) {
      if (disposed) return;
      cancel();
      emit({ kind: "ready", snapshot: { unread, confirmedAt: Date.now() } });
      schedule();
    },
    dispose() {
      disposed = true;
      cancel();
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PERSONAL_NOTIFICATION_COUNT_EVENT, countEvent);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}
