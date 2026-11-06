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

/** The browser observes the authenticated venue feed; passwords never enter this hook. */
export function useProPresenter({ orgId, host, port, enabled, onSlideChange }: UseProPresenterOptions) {
  const [status, setStatus] = useState<PPConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState<PPSlideData | null>(null);
  const [debugInfo, setDebugInfo] = useState<PPDebugInfo | null>(null);
  const [requested, setRequested] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const onSlideChangeRef = useRef(onSlideChange);
  onSlideChangeRef.current = onSlideChange;

  useEffect(() => { setCurrentSlide(null); setError(null); setRequested(true); }, [orgId]);
  useEffect(() => {
    if (!enabled || !requested) { setStatus("disconnected"); setDebugInfo(null); return; }
    let disposed = false;
    let polling = false;
    let revision = 0;
    let lastSlideKey: string | undefined;
    let target: string | null = host && port ? `propresenter:${host}:${port}` : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bridge = getSharedProPresenterProxy(orgId);
    const debug: PPDebugInfo = { wsConnected: bridge.isBridgeOnline(), wsMessagesReceived: 0, lastWsMessage: null,
      lastSlideText: null, pollingActive: true, pollSuccessCount: 0, lastPollResult: null };
    setStatus("connecting");
    setError(null);
    setDebugInfo({ ...debug });
    const apply = (event: ProPresenterFeedEvent | null) => {
      if (!event || disposed) return;
      const slide = event.kind === "slide" ? event.slide : null;
      // Arrival timestamps change during refresh; slide content and identity determine updates.
      const key = slide ? JSON.stringify([slide.text, slide.notes, slide.presentationName, slide.slideIndex, slide.isScripture, slide.slideId ?? null, slide.nextText ?? "", slide.nextSlideId ?? null]) : "clear";
      if (key === lastSlideKey) return;
      lastSlideKey = key;
      setCurrentSlide(slide);
      onSlideChangeRef.current?.(slide);
      debug.lastSlideText = slide?.text ?? null;
    };
    const refresh = async () => {
      if (disposed || polling || document.visibilityState === "hidden") return;
      polling = true;
      const startingRevision = revision;
      try {
        const result = await getProPresenterFeed({ data: { orgId } });
        if (disposed || startingRevision !== revision) return;
        target = result.target;
        setStatus(result.status);
        setError(result.error ?? null);
        debug.wsConnected = result.bridgeOnline;
        debug.pollSuccessCount++;
        debug.lastPollResult = result.error ?? result.event?.kind ?? "Waiting for slide";
        apply(result.event);
        setDebugInfo({ ...debug });
      } catch {
        if (!disposed && startingRevision === revision) {
          setStatus("error");
          setError("ProPresenter feed could not be refreshed. Retaining the last confirmed slide.");
        }
      } finally { polling = false; }
    };
    const schedule = () => {
      if (disposed) return;
      timer = setTimeout(() => { void refresh().finally(schedule); }, 2000);
    };
    const unsubscribeStatus = bridge.onBridgeStatus(online => {
      if (disposed) return;
      debug.wsConnected = online;
      setDebugInfo({ ...debug });
      if (!online) { revision++; setStatus("error"); setError("Venue Bridge is offline. Retaining the last confirmed slide."); }
      else void refresh();
    });
    const unsubscribeDevice = bridge.onDeviceStatus((address, connected) => {
      if (disposed || address !== target) return;
      revision++;
      setStatus(connected ? "connected" : "error");
      setError(connected ? null : "ProPresenter disconnected. Retaining the last confirmed slide.");
    });
    const unsubscribeEvents = bridge.onDeviceEvent((address, eventName, data) => {
      if (disposed || !target || address !== target || eventName !== "slide") return;
      const event = parseProPresenterFeedEvent(data, Date.now());
      if (!event) return;
      revision++;
      debug.wsMessagesReceived++;
      debug.lastWsMessage = event.kind;
      setStatus("connected");
      setError(null);
      apply(event);
      setDebugInfo({ ...debug });
    });
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    void refresh().finally(schedule);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribeStatus(); unsubscribeDevice(); unsubscribeEvents();
      document.removeEventListener("visibilitychange", onVisible);
      // Reading a feed never grants authority to stop the shared venue connection.
    };
  }, [orgId, host, port, enabled, requested, attempt]);

  const connect = useCallback(() => { setRequested(true); setAttempt(value => value + 1); }, []);
  const disconnect = useCallback(() => { setRequested(false); }, []);
  return { status, error, currentSlide, connect, disconnect, isStreaming: status === "connected" && enabled, debugInfo };
}
