/** Transport readiness is separate from a clock's playback or source signal. */
export type ConnectionStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export const connectionLabel = {
  disabled: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
  error: "Connection error",
} satisfies Record<ConnectionStatus, string>;
