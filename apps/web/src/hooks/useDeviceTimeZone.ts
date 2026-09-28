import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
};
export const getDeviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const serverTimeZone = () => "UTC";

/** Use the viewer's timezone after hydration without differing from server HTML. */
export function useDeviceTimeZone() {
  return useSyncExternalStore(subscribe, getDeviceTimeZone, serverTimeZone);
}
