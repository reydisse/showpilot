import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import {
  DESKTOP_NOTIFICATION_POLL_EVENT,
  isDesktopMainWindow,
  isDesktopRuntime,
} from "@/lib/desktop-runtime";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import type { DesktopNotificationState } from "@/lib/desktop-notification-state";
import { DesktopNotificationContext } from "./DesktopNotificationContext";

/** One owner survives route changes; web and display windows do not load native delivery. */
export function DesktopNotificationController({
  children,
}: {
  children?: ReactNode;
}) {
  const { slug } = useParams({ strict: false });
  const [current, setCurrent] = useState<{
    slug: string;
    state: DesktopNotificationState;
  } | null>(null);
  const retry = useRef<() => void>(() => {});
  useEffect(() => {
    if (!isDesktopRuntime() || !isDesktopMainWindow() || !slug) return;
    const lifetime = new AbortController();
    let loading = false;
    let delivery: { refresh: () => void } | undefined;
    const boot = async () => {
      if (loading || lifetime.signal.aborted) return;
      if (delivery) {
        delivery.refresh();
        return;
      }
      loading = true;
      setCurrent((previous) => ({
        slug,
        state: {
          kind: "starting",
          previousFailure:
            previous?.slug === slug && previous.state.kind === "load-failed"
              ? previous.state.failure
              : null,
        },
      }));
      try {
        const module = await runRouteLoad(
          () => import("@/lib/desktop-notification-delivery"),
          lifetime.signal,
        );
        lifetime.signal.throwIfAborted();
        setCurrent({
          slug,
          state: {
            kind: "running",
            inbox: { kind: "ready" },
            actions: { kind: "ready" },
          },
        });
        delivery = module.startDesktopNotificationDelivery({
          slug,
          signal: lifetime.signal,
          onStatus: (channel, status) => {
            if (!lifetime.signal.aborted)
              setCurrent((previous) =>
                previous?.slug === slug && previous.state.kind === "running"
                  ? { slug, state: { ...previous.state, [channel]: status } }
                  : previous,
              );
          },
        });
      } catch {
        if (!lifetime.signal.aborted)
          setCurrent({
            slug,
            state: {
              kind: "load-failed",
              failure: {
                message:
                  "Desktop alerts could not start. Retry notification setup.",
                at: Date.now(),
              },
            },
          });
      } finally {
        loading = false;
      }
    };
    const refresh = () => {
      void boot();
    };
    retry.current = refresh;
    window.addEventListener(DESKTOP_NOTIFICATION_POLL_EVENT, refresh);
    refresh();
    return () => {
      lifetime.abort();
      retry.current = () => {};
      window.removeEventListener(DESKTOP_NOTIFICATION_POLL_EVENT, refresh);
    };
  }, [slug]);
  return (
    <DesktopNotificationContext.Provider
      value={
        current && current.slug === slug
          ? { state: current.state, retry: () => retry.current() }
          : null
      }
    >
      {children}
    </DesktopNotificationContext.Provider>
  );
}
