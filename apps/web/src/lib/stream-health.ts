export function normalizeLiveInputStatus(rawStatus: string, enabled = true) {
  if (rawStatus === "connected" || rawStatus === "reconnected" || rawStatus === "live_streaming") return "streaming";
  if (rawStatus === "reconnecting" || rawStatus === "new_configuration_accepted") return "connecting";
  if (rawStatus === "client_disconnect") return "idle";
  if (rawStatus === "ttl_exceeded" || rawStatus === "failed_to_connect" || rawStatus === "failed_to_reconnect") return "error";
  if (!enabled) return "disabled";
  return "idle";
}
