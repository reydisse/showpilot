import { lazy, Suspense } from "react";
import { useDesktopRuntime } from "@/hooks/useDesktopRuntime";

const BridgeController = lazy(() => import("./DesktopBridgeController").then((module) => ({
  default: module.DesktopBridgeController,
})));
const NotificationController = lazy(() => import("./DesktopNotificationController").then((module) => ({
  default: module.DesktopNotificationController,
})));

/** Browser sessions never download the native background controllers. */
export function DesktopControllers() {
  const desktop = useDesktopRuntime();
  if (!desktop) return null;

  return (
    <Suspense fallback={null}>
      <BridgeController />
      <NotificationController />
    </Suspense>
  );
}
