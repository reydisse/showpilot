import { parseRelayPPSlide } from "./rundown-relay-payload";

// Public feed payloads only. Device authentication belongs to the venue Bridge.
export interface PPSlideData {
  /** Current slide text content */
  text: string;
  /** Optional notes/scripture reference */
  notes: string;
  /** Presentation name (e.g., "Worship Set" or "John 3:16") */
  presentationName: string;
  /** Slide index within the presentation */
  slideIndex: number;
  /** Whether this is a scripture/Bible presentation */
  isScripture: boolean;
  /** Timestamp when slide was received */
  receivedAt: number;
  /** Stable slide identity if PP provides one */
  slideId?: string;
  nextText?: string;
  nextSlideId?: string;
}

export type PPConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface PPDebugInfo {
  wsConnected: boolean;
  wsMessagesReceived: number;
  lastWsMessage: string | null;
  lastSlideText: string | null;
  pollingActive: boolean;
  pollSuccessCount: number;
  lastPollResult: string | null;
}

export type ProPresenterFeedEvent = { kind: "slide"; slide: PPSlideData } | { kind: "clear" };
export interface ProPresenterFeedState {
  status: PPConnectionStatus;
  target: string | null;
  bridgeOnline: boolean;
  event: ProPresenterFeedEvent | null;
  error?: string;
}

export function parseProPresenterFeedEvent(data: string, receivedAt: number): ProPresenterFeedEvent | null {
  let value: unknown;
  try { value = JSON.parse(data); } catch { return null; }
  if (value === null) return { kind: "clear" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== "string") return null;
  if (record.text === "") return { kind: "clear" };
  const slide = parseRelayPPSlide({ ...record,
    notes: typeof record.notes === "string" ? record.notes : "",
    presentationName: typeof record.presentationName === "string" ? record.presentationName : typeof record.pn === "string" ? record.pn : "",
    isScripture: Boolean(record.isScripture ?? record.scripture),
  });
  return slide ? { kind: "slide", slide: { ...slide, receivedAt, slideIndex: typeof record.slideIndex === "number" ? record.slideIndex : 0 } } : null;
}
