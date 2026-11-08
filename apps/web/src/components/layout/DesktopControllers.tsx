import { lazy, Suspense, useState, type ReactNode } from "react";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";
import { DesktopNotificationContext, type DesktopNotificationDelivery } from "./DesktopNotificationContext";

const BridgeController = lazy(() => import("./DesktopBridgeController").then((module) => ({
  default: module.DesktopBridgeController,
})));
const NotificationController = lazy(() => import("./DesktopNotificationController").then((module) => ({
  default: module.DesktopNotificationController,
})));

/** Browser sessions never download the native background controllers. */
export function DesktopControllers({ children }: { children: ReactNode }) {
  const desktop = useDesktopRuntime();
  const [delivery, setDelivery] = useState<DesktopNotificationDelivery | null>(null);

  return (
    <DesktopNotificationContext.Provider value={desktop ? delivery : null}>
      {children}
      {desktop ? <Suspense fallback={null}>
        <BridgeController />
        <NotificationController onDeliveryChange={setDelivery} />
      </Suspense> : null}
    </DesktopNotificationContext.Provider>
  );
}
