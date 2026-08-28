export type RundownPlayback = "stop" | "play" | "pause";
export type PersistedRundownRunStatus = "stopped" | "running" | "paused";

export function persistedRundownStatus(playback: RundownPlayback): PersistedRundownRunStatus {
  switch (playback) {
    case "play":
      return "running";
    case "pause":
      return "paused";
    case "stop":
      return "stopped";
  }
}

export function mobileRundownStatus(playback: RundownPlayback, storedStatus: string): string {
  if (playback !== "stop") return persistedRundownStatus(playback);
  return storedStatus === "running" || storedStatus === "paused" ? "stopped" : storedStatus;
}

export function rundownPhaseStatus(storedStatus: string): "stopped" | "live" | "complete" {
  if (storedStatus === "live" || storedStatus === "running" || storedStatus === "paused") return "live";
  return storedStatus === "complete" ? "complete" : "stopped";
}
