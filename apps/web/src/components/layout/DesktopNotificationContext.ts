import { createContext, useContext } from "react";
import type { DesktopNotificationState } from "@/lib/desktop-notification-state";

export const DesktopNotificationContext = createContext<{
  state: DesktopNotificationState;
  retry: () => void;
} | null>(null);
export const useDesktopNotificationDelivery = () =>
  useContext(DesktopNotificationContext);
