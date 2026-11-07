import { createContext, useContext } from "react";

export const SongLibraryRefresh = createContext<((signal: AbortSignal) => Promise<void>) | null>(null);

/** Refresh the library without replacing an active editor or recovery dialog. */
export function useSongLibraryRefresh() {
  const refresh = useContext(SongLibraryRefresh);
  if (!refresh) throw new Error("Song library refresh requires the Songs route.");
  return refresh;
}
