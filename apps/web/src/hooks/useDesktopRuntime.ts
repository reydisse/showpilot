import { useSyncExternalStore } from "react";
import { isDesktopRuntime } from "@/lib/desktop-runtime";

// Tauri installs its runtime before the page loads; its presence does not change
// during a document's lifetime. The server cannot observe that native runtime.
const subscribe = () => () => {};
const serverSnapshot = () => false;

/** Match server HTML on hydration, then reveal this document's native controls. */
export function useDesktopRuntime() {
  return useSyncExternalStore(subscribe, isDesktopRuntime, serverSnapshot);
}
