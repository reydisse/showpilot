import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, ChevronRight } from "lucide-react";
import { enablePushForOrg, isPushSupported } from "@/lib/notifications";
import { readDeviceNotificationStatus } from "@/lib/device-notification-status";
import { runRouteLoad } from "@/lib/route-load-deadlines";
import {
  DESKTOP_NOTIFICATION_POLL_EVENT,
  isDesktopNotificationSupported,
} from "@/lib/desktop-runtime";

/** Permission/setup code is only needed when the account menu is open. */
export function DeviceNotificationsControl({ orgId }: { orgId: string }) {
  const [pushPermission, setPushPermission] =
    useState<NotificationPermission>("default");
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushStatusReady, setPushStatusReady] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [enablingPush, setEnablingPush] = useState(false);
  useEffect(() => {
    let active = true;
    const supported = isPushSupported();
    setPushSupported(supported);
    setPushEnabled(false);
    setPushError(null);
    setPushStatusReady(!supported);
    if (!supported)
      return () => {
        active = false;
      };

    setPushPermission("default");
    void runRouteLoad(() => readDeviceNotificationStatus(orgId)).then(
      ({ permission, enabled }) => {
        if (!active) return;
        setPushPermission(permission);
        setPushEnabled(enabled);
        setPushStatusReady(true);
      },
      () => {
        if (!active) return;
        setPushStatusReady(true);
        setPushError(
          "Could not check device notifications. Try enabling alerts again.",
        );
      },
    );
    return () => {
      active = false;
    };
  }, [orgId]);

  const enablePush = async () => {
    setEnablingPush(true);
    try {
      const setup = enablePushForOrg(orgId); // Keep the permission prompt in the click handler.
      const permission = await runRouteLoad(() => setup);
      setPushPermission(permission);
      setPushEnabled(permission === "granted");
      if (permission === "granted" && isDesktopNotificationSupported()) {
        window.dispatchEvent(new Event(DESKTOP_NOTIFICATION_POLL_EVENT));
      }
      setPushError(null);
    } catch {
      setPushEnabled(false);
      setPushError(
        "Device alerts were not confirmed. Try enabling them again.",
      );
    } finally {
      setEnablingPush(false);
    }
  };

  return (
    <>
      {pushSupported && !pushStatusReady ? (
        <p role="status" className="p-3 text-xs text-board-muted">
          Checking device notifications…
        </p>
      ) : null}
      {pushSupported && pushStatusReady ? (
        pushEnabled || pushPermission === "denied" ? (
          <div className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted">
            {pushEnabled ? (
              <CheckCircle2 className="size-[18px] text-green-500" />
            ) : (
              <BellRing className="size-[18px] text-red-400" />
            )}
            <span className="min-w-0 text-left">
              <span className="block text-sm font-medium text-board-text">
                Device notifications
              </span>
              <span className="mt-0.5 block text-xs leading-5">
                {pushEnabled
                  ? "Enabled on this device"
                  : "Blocked in browser or system settings"}
              </span>
            </span>
          </div>
        ) : (
          <button
            type="button"
            disabled={enablingPush}
            onClick={() => void enablePush()}
            className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-3 text-board-muted transition-colors hover:bg-board-border/50 hover:text-board-text disabled:opacity-50"
          >
            <BellRing className="size-[18px]" />
            <span className="min-w-0 text-left">
              <span className="block text-sm font-medium text-board-text">
                Device notifications
              </span>
              <span className="mt-0.5 block text-xs leading-5">
                {enablingPush
                  ? "Enabling on this device"
                  : "Enable alerts when ShowPilot is in the background"}
              </span>
            </span>
            <ChevronRight className="ml-auto size-3.5 opacity-40" />
          </button>
        )
      ) : null}
      {pushError ? (
        <p role="alert" className="px-3 py-1 text-xs leading-5 text-red-400">
          {pushError}
        </p>
      ) : null}
    </>
  );
}
