import { parseProPresenterFeedEvent } from "./propresenter-client";

/** A slide observer receives no other device events, replies, installation data or controls. */
export function proPresenterViewerMessage(data: string): string | null {
  let message: unknown;
  try { message = JSON.parse(data); } catch { return null; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (record.type === "bridge-status") return JSON.stringify({ type: "bridge-status", online: record.online === true });
  if (typeof record.target !== "string" || !record.target.startsWith("propresenter:")) return null;
  if (record.type === "device-status") return JSON.stringify({ type: "device-status", target: record.target, connected: record.connected === true });
  if (record.type !== "device-event" || record.eventName !== "slide" || typeof record.data !== "string") return null;
  const event = parseProPresenterFeedEvent(record.data, Date.now());
  if (!event) return null;
  return JSON.stringify({ type: "device-event", target: record.target, eventName: "slide", data: JSON.stringify(event.kind === "slide" ? event.slide : null) });
}
