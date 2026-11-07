export function normalizeLiveInputStatus(rawStatus: string, enabled = true) {
  if (!enabled) return "disabled";
  if (rawStatus === "connected" || rawStatus === "reconnected" || rawStatus === "live_streaming") return "streaming";
  if (rawStatus === "reconnecting" || rawStatus === "new_configuration_accepted") return "connecting";
  if (rawStatus === "client_disconnect" || rawStatus === "idle") return "idle";
  if (rawStatus === "ttl_exceeded" || rawStatus === "failed_to_connect" || rawStatus === "failed_to_reconnect") return "error";
  return "unknown";
}
