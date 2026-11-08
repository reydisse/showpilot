import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import {
  DESKTOP_NOTIFICATION_POLL_EVENT,
  isDesktopMainWindow,
  isDesktopRuntime,
} from "@/lib/desktop-runtime";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import type { DesktopNotificationState } from "@/lib/desktop-notification-state";
import type { DesktopNotificationDelivery } from "./DesktopNotificationContext";

/** One owner survives route changes; web and display windows do not load native delivery. */
export function DesktopNotificationController({
  onDeliveryChange,
}: {
  onDeliveryChange: (delivery: DesktopNotificationDelivery | null) => void;
}) {
  const { slug } = useParams({ strict: false });
  useEffect(() => {
    if (!isDesktopRuntime() || !isDesktopMainWindow() || !slug) return;
    const lifetime = new AbortController();
    let loading = false;
    let delivery: { refresh: () => void } | undefined;
    let state: DesktopNotificationState = { kind: "starting", previousFailure: null };
    const publish = (next: DesktopNotificationState) => {
      state = next;
      onDeliveryChange({ state, retry: refresh });
    };
    const boot = async () => {
      if (loading || lifetime.signal.aborted) return;
      if (delivery) {
        delivery.refresh();
        return;
      }
      loading = true;
      publish({
        kind: "starting",
        previousFailure: state.kind === "load-failed" ? state.failure : null,
      });
      try {
        const module = await runRouteLoad(
          () => import("@/lib/desktop-notification-delivery"),
          lifetime.signal,
        );
        lifetime.signal.throwIfAborted();
        publish({
          kind: "running",
          inbox: { kind: "ready" },
          actions: { kind: "ready" },
        });
        delivery = module.startDesktopNotificationDelivery({
          slug,
          signal: lifetime.signal,
          onStatus: (channel, status) => {
            if (!lifetime.signal.aborted && state.kind === "running")
              publish({ ...state, [channel]: status });
          },
        });
      } catch {
        if (!lifetime.signal.aborted)
          publish({
            kind: "load-failed",
            failure: {
              message:
                "Desktop alerts could not start. Retry notification setup.",
              at: Date.now(),
            },
          });
      } finally {
        loading = false;
      }
    };
    const refresh = () => {
      void boot();
    };
    window.addEventListener(DESKTOP_NOTIFICATION_POLL_EVENT, refresh);
    refresh();
    return () => {
      lifetime.abort();
      onDeliveryChange(null);
      window.removeEventListener(DESKTOP_NOTIFICATION_POLL_EVENT, refresh);
    };
  }, [slug, onDeliveryChange]);
  return null;
}
