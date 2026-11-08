import { createContext, useContext } from "react";
import type { DesktopNotificationState } from "@/lib/desktop-notification-state";

export type DesktopNotificationDelivery = {
  state: DesktopNotificationState;
  retry: () => void;
};
export const DesktopNotificationContext = createContext<DesktopNotificationDelivery | null>(null);
export const useDesktopNotificationDelivery = () =>
  useContext(DesktopNotificationContext);
