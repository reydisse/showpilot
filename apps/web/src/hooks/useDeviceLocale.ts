import { useSyncExternalStore } from "react";

const subscribe = (onChange: () => void) => {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
};
const deviceLocale = () => Intl.DateTimeFormat().resolvedOptions().locale;
const serverLocale = () => "en-US";

/** Keep the server and first browser render equal, then use the viewer's locale. */
export function useDeviceLocale() {
  return useSyncExternalStore(subscribe, deviceLocale, serverLocale);
}
