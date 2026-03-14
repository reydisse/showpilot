import { useState, useEffect, useRef, useCallback } from "react";
import {
  ProPresenterClient,
  type PPSlideData,
  type PPConnectionStatus,
} from "@/lib/propresenter-client";

interface UseProPresenterOptions {
  /** PP host IP/hostname from org settings */
  host: string;
  /** PP port from org settings */
  port: number;
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
}

/**
 * React hook for managing ProPresenter connection.
 * Connects from the operator's browser to PP on the local network.
 * Calls onSlideChange when the current slide updates — the parent
 * component should relay this to the server for kiosk consumption.
 */
export function useProPresenter({
  host,
  port,
  enabled,
  onSlideChange,
}: UseProPresenterOptions): UseProPresenterReturn {
  const [status, setStatus] = useState<PPConnectionStatus>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [currentSlide, setCurrentSlide] = useState<PPSlideData | null>(null);
  const clientRef = useRef<ProPresenterClient | null>(null);
  const onSlideChangeRef = useRef(onSlideChange);
  onSlideChangeRef.current = onSlideChange;

  // Connect/disconnect based on enabled + host + port
  useEffect(() => {
    if (!enabled || !host || !port) {
      // Disconnect if disabled or missing config
      if (clientRef.current) {
        clientRef.current.disconnect();
        clientRef.current = null;
      }
      setStatus("disconnected");
      setCurrentSlide(null);
      return;
    }

    const client = new ProPresenterClient({
      host,
      port,
      onSlideChange: (slide) => {
        setCurrentSlide(slide);
        onSlideChangeRef.current?.(slide);
      },
      onStatusChange: (newStatus, errorMsg) => {
        setStatus(newStatus);
        setError(errorMsg || null);
      },
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, [enabled, host, port]);

  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
    }
    if (!host || !port) return;

    const client = new ProPresenterClient({
      host,
      port,
      onSlideChange: (slide) => {
        setCurrentSlide(slide);
        onSlideChangeRef.current?.(slide);
      },
      onStatusChange: (newStatus, errorMsg) => {
        setStatus(newStatus);
        setError(errorMsg || null);
      },
    });
    clientRef.current = client;
    client.connect();
  }, [host, port]);

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.disconnect();
      clientRef.current = null;
    }
    setStatus("disconnected");
    setCurrentSlide(null);
  }, []);

  return {
    status,
    error,
    currentSlide,
    connect,
    disconnect,
    isStreaming: status === "connected" && enabled,
  };
}
