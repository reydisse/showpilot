import {
  getDesktopNotificationPermission,
  isDesktopNotificationSupported,
} from "@/lib/desktop-runtime";
import { enablePushForOrg } from "@/lib/notifications";

/** Runs after mount, without prompting for permission. */
export async function readDeviceNotificationStatus(orgId: string) {
  if (isDesktopNotificationSupported()) {
    const permission = await getDesktopNotificationPermission();
    return { permission, enabled: permission === "granted" };
  }
  const permission = Notification.permission;
  const enabled =
    permission === "granted" &&
    (await enablePushForOrg(orgId, false)) === "granted";
  return { permission, enabled };
}
