import { useState, useEffect, useRef, useCallback } from "react";
import {
  ProPresenterClient,
  type PPSlideData,
  type PPConnectionStatus,
  type PPDebugInfo,
} from "@/lib/propresenter-client";
import { pollProPresenterSlide } from "@/lib/rundown";

interface UseProPresenterOptions {
  /** PP host IP/hostname from org settings */
  host: string;
  /** PP stage display port (default 50001) */
  port: number;
  /** PP API port (Remote Control port, for REST polling fallback) */
  apiPort?: number;
  /** Stage display password */
  password?: string;
  /** Whether PP streaming is enabled */
  enabled: boolean;
  /** Called when slide changes — use this to relay to server */
  onSlideChange?: (slide: PPSlideData | null) => void;
}

interface UseProPresenterReturn {
  /** Current connection status */
  status: PPConnectionStatus;
  /** Error message if any */
  error: string | null;
  /** Current slide data from PP */
  currentSlide: PPSlideData | null;
  /** Manually connect */
  connect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
  /** Whether streaming is active (connected + enabled) */
  isStreaming: boolean;
  /** Debug info for troubleshooting */
  debugInfo: PPDebugInfo | null;
}

/** Server-side polling function that bypasses CORS */
async function serverPollPP(host: string, port: number): Promise<PPSlideData | null> {
  try {
    const result = await pollProPresenterSlide({ data: { host, port } });
    if (!result) return null;
    return {
      text: result.text,
      notes: result.notes,
      presentationName: result.presentationName,
      slideIndex: 0,
      isScripture: result.isScripture,
      receivedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * React hook for managing ProPresenter connection.
 * Connects from the operator's browser to PP on the local network.
 * Falls back to server-side REST polling if WebSocket doesn't deliver slides.
 */
export function useProPresenter({
  host,
  port,
  apiPort,
  password,
  enabled,
  onSlideChange,
}: UseProPresenterOptions): UseProPresenterReturn {
  const [status, setStatus] = useState<PPConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState<PPSlideData | null>(null);
  const [debugInfo, setDebugInfo] = useState<PPDebugInfo | null>(null);
  const clientRef = useRef<ProPresenterClient | null>(null);
  const onSlideChangeRef = useRef(onSlideChange);
  onSlideChangeRef.current = onSlideChange;

  // Connect/disconnect based on enabled + host + port
  useEffect(() => {
    if (!enabled || !host || !port) {
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      setStatus("disconnected");
      setCurrentSlide(null);
      setDebugInfo(null);
      return;
    }

    const client = new ProPresenterClient({
      host,
      port,
      password,
      onSlideChange: (slide) => {
        setCurrentSlide(slide);
        onSlideChangeRef.current?.(slide);
      },
      onStatusChange: (newStatus, errorMsg) => {
        setStatus(newStatus);
        setError(errorMsg || null);
      },
      onDebug: (info) => {
        setDebugInfo(info);
      },
    });

    clientRef.current = client;
    // Pass API port separately so the client polls on the correct port
    const resolvedApiPort = apiPort || port;
    client.connect((h, p) => serverPollPP(h, p), resolvedApiPort);

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [enabled, host, port, apiPort, password]);

  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
    if (!host || !port) return;

    const client = new ProPresenterClient({
      host,
      port,
      password,
      onSlideChange: (slide) => {
        setCurrentSlide(slide);
        onSlideChangeRef.current?.(slide);
      },
      onStatusChange: (newStatus, errorMsg) => {
        setStatus(newStatus);
        setError(errorMsg || null);
      },
      onDebug: (info) => {
        setDebugInfo(info);
      },
    });
    clientRef.current = client;
    const resolvedApiPort = apiPort || port;
    client.connect((h, p) => serverPollPP(h, p), resolvedApiPort);
  }, [host, port, apiPort, password]);

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
    setStatus("disconnected");
    setCurrentSlide(null);
    setDebugInfo(null);
  }, []);

  return {
    status,
    error,
    currentSlide,
    connect,
    disconnect,
    isStreaming: status === "connected" && enabled,
    debugInfo,
  };
}
