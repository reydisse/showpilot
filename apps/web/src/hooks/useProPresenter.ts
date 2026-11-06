import { useState, useEffect, useRef, useCallback } from "react";
import { parseProPresenterFeedEvent, type PPSlideData, type PPConnectionStatus, type PPDebugInfo, type ProPresenterFeedEvent } from "@/lib/propresenter-client";
import { getSharedProPresenterProxy } from "@/lib/device-modules/bridge-proxy";
import { getProPresenterFeed } from "@/lib/rundown";

interface UseProPresenterOptions {
  orgId: string;
  host: string;
  port: number;
  enabled: boolean;
  onSlideChange?: (slide: PPSlideData | null) => void;
}
interface FeedState {
  scope: string;
  status: PPConnectionStatus;
  error: string | null;
  errorAt: number | null;
  currentSlide: PPSlideData | null;
  debugInfo: PPDebugInfo | null;
  refreshing: boolean;
}
interface PendingRead { controller: AbortController; deadline?: ReturnType<typeof setTimeout> }
const emptyState = (scope: string): FeedState => ({ scope, status: "disconnected", error: null, errorAt: null, currentSlide: null, debugInfo: null, refreshing: false });
const slideKey = (slide: PPSlideData | null) => slide ? JSON.stringify([slide.text, slide.notes, slide.presentationName, slide.slideIndex, slide.isScripture, slide.slideId ?? null, slide.nextText ?? "", slide.nextSlideId ?? null]) : "clear";

/** The browser observes the authenticated venue feed; passwords never enter this hook. */
export function useProPresenter({ orgId, host, port, enabled, onSlideChange }: UseProPresenterOptions) {
  const scope = JSON.stringify([orgId, host, port]);
  const [state, setState] = useState(() => emptyState(scope));
  const [requestChoice, setRequestChoice] = useState({ scope, requested: true });
  const requested = requestChoice.scope !== scope || requestChoice.requested;
  const [attempt, setAttempt] = useState(0);
  const confirmed = useRef<{ scope: string; key?: string; slide: PPSlideData | null }>({ scope, slide: null });
  const onSlideChangeRef = useRef(onSlideChange);
  onSlideChangeRef.current = onSlideChange;

  useEffect(() => {
    if (confirmed.current.scope !== scope) confirmed.current = { scope, slide: null };
    if (!enabled || !requested) {
      confirmed.current.key = undefined;
      setState(previous => ({ ...emptyState(scope), currentSlide: previous.scope === scope ? previous.currentSlide : null }));
      return;
    }
    let disposed = false;
    let failures = 0;
    let request: PendingRead | null = null;
    let target: string | null = host && port ? `propresenter:${host}:${port}` : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bridge = getSharedProPresenterProxy(orgId);
    const debug: PPDebugInfo = { wsConnected: bridge.isBridgeOnline(), wsMessagesReceived: 0, lastWsMessage: null,
      lastSlideText: confirmed.current.slide?.text ?? null, pollingActive: document.visibilityState !== "hidden", pollSuccessCount: 0, lastPollResult: null };
    setState(previous => ({ ...(previous.scope === scope ? previous : emptyState(scope)), status: previous.scope === scope && previous.error ? "error" : "connecting", debugInfo: { ...debug } }));
    const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const cancelRead = () => {
      const current = request; request = null;
      if (current?.deadline !== undefined) clearTimeout(current.deadline);
      current?.controller.abort();
      if (!disposed) setState(previous => ({ ...previous, refreshing: false }));
    };
    const fail = (message: string) => {
      failures++;
      setState(previous => ({ ...previous, status: "error", error: message, errorAt: Date.now(), debugInfo: { ...debug } }));
    };
    const connectConfirmed = () => {
      failures = 0;
      setState(previous => ({ ...previous, status: "connected", error: null, errorAt: null, debugInfo: { ...debug } }));
    };
    const apply = (event: ProPresenterFeedEvent | null) => {
      if (!event || disposed) return;
      const slide = event.kind === "slide" ? event.slide : null;
      // Arrival timestamps change during refresh; content and identity determine updates.
      const key = slideKey(slide);
      if (key === confirmed.current.key) return;
      confirmed.current = { scope, key, slide };
      debug.lastSlideText = slide?.text ?? null;
      setState(previous => ({ ...previous, currentSlide: slide, debugInfo: { ...debug } }));
      onSlideChangeRef.current?.(slide);
    };
    const schedule = () => {
      if (disposed || timer !== undefined || document.visibilityState === "hidden") return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, Math.min(2000 * 2 ** Math.min(failures, 4), 30_000));
    };
    const refresh = async () => {
      if (disposed || request || document.visibilityState === "hidden") return;
      clearTimer();
      const current: PendingRead = { controller: new AbortController() };
      request = current;
      setState(previous => ({ ...previous, refreshing: true }));
      try {
        const result = await Promise.race([
          getProPresenterFeed({ data: { orgId }, signal: current.controller.signal }),
          new Promise<never>((_resolve, reject) => {
            current.deadline = setTimeout(() => { current.controller.abort(); reject(new Error("Feed confirmation timed out")); }, 8_000);
          }),
        ]);
        if (disposed || request !== current) return;
        target = result.target;
        debug.wsConnected = result.bridgeOnline;
        debug.pollSuccessCount++;
        debug.lastPollResult = result.error ?? result.event?.kind ?? "Waiting for slide";
        if (result.status === "connected" && result.bridgeOnline) {
          connectConfirmed();
          apply(result.event);
        } else {
          fail(result.error || "ProPresenter is disconnected. Retaining the last confirmed slide.");
        }
      } catch {
        if (!disposed && request === current) fail("ProPresenter feed could not be refreshed. Retaining the last confirmed slide.");
      } finally {
        if (current.deadline !== undefined) clearTimeout(current.deadline);
        if (request === current) {
          request = null;
          if (!disposed) { setState(previous => ({ ...previous, refreshing: false })); schedule(); }
        }
      }
    };
    const unsubscribeStatus = bridge.onBridgeStatus(online => {
      if (disposed) return;
      cancelRead();
      debug.wsConnected = online;
      setState(previous => ({ ...previous, debugInfo: { ...debug } }));
      if (!online) {
        fail("Venue Bridge is offline. Retaining the last confirmed slide.");
        clearTimer(); schedule();
      } else void refresh();
    });
    const unsubscribeDevice = bridge.onDeviceStatus((address, connected) => {
      if (disposed || address !== target) return;
      cancelRead();
      if (connected) connectConfirmed();
      else fail("ProPresenter disconnected. Retaining the last confirmed slide.");
      clearTimer(); schedule();
    });
    const unsubscribeEvents = bridge.onDeviceEvent((address, eventName, data) => {
      if (disposed || !target || address !== target || eventName !== "slide") return;
      const event = parseProPresenterFeedEvent(data, Date.now());
      if (!event) return;
      cancelRead();
      debug.wsMessagesReceived++;
      debug.lastWsMessage = event.kind;
      connectConfirmed();
      apply(event);
      schedule();
    });
    const onVisibility = () => {
      clearTimer();
      debug.pollingActive = document.visibilityState !== "hidden";
      setState(previous => ({ ...previous, debugInfo: { ...debug } }));
      if (debug.pollingActive) void refresh();
      else cancelRead();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      disposed = true;
      clearTimer(); cancelRead();
      unsubscribeStatus(); unsubscribeDevice(); unsubscribeEvents();
      document.removeEventListener("visibilitychange", onVisibility);
      // Reading a feed never grants authority to stop the shared venue connection.
    };
  }, [scope, orgId, host, port, enabled, requested, attempt]);

  const connect = useCallback(() => { setRequestChoice({ scope, requested: true }); setAttempt(value => value + 1); }, [scope]);
  const disconnect = useCallback(() => { setRequestChoice({ scope, requested: false }); }, [scope]);
  const current = state.scope === scope ? state : emptyState(scope);
  const visible = enabled && requested ? current : { ...emptyState(scope), currentSlide: current.currentSlide };
  return { ...visible, connect, disconnect, isStreaming: visible.status === "connected" };
}
