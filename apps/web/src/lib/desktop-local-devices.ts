import {
  getDesktopBridgeStatus,
  isDesktopLocalDeviceMode,
  startDesktopBridge,
  type DesktopBridgeStatus,
} from "@/lib/desktop-runtime";
import { getOrgRouteContext } from "@/lib/session";
import { getDesktopBridgeAccess } from "@/lib/settings";

/**
 * Starts this Desktop's embedded Bridge only after local-device mode has been
 * explicitly enabled. Additional installations start on standby; switching
 * the active venue Bridge requires explicit takeover in settings.
 */
export async function configureDesktopLocalDevices(
  slug: string,
  forceEnable = false,
  shouldContinue: () => boolean = () => true,
): Promise<DesktopBridgeStatus> {
  const status = await getDesktopBridgeStatus();
  if (!status) throw new Error("ShowPilot Desktop is not available");
  if (!forceEnable && !isDesktopLocalDeviceMode(status)) return status;
  if (!status.secureCredentials) {
    throw new Error("Update ShowPilot Desktop to enable secure local-device credentials.");
  }

  const sameInstallation = status.configured
    && status.configuredSite?.replace(/\/+$/, "") === window.location.origin
    && status.configuredOrg === slug;
  // Opening another workspace must not replace a running venue Bridge.
  if (!sameInstallation && !forceEnable) return status;
  if (status.connection === "unauthorized" && !forceEnable) {
    throw new Error("This computer's Bridge key is no longer authorized. Choose Use this computer to reconnect with a new installation key.");
  }

  const context = await getOrgRouteContext({ data: slug });
  if (!context) throw new Error("Sign in before enabling local devices");
  await getDesktopBridgeAccess({ data: { orgId: context.org.id } });
  if (!shouldContinue()) return status;
  const issued = !sameInstallation || status.connection === "unauthorized"
    ? await (await import("@/lib/bridge-installations")).createBridgeInstallation({ data: { orgId: context.org.id, label: "ShowPilot Desktop" } })
    : null;
  if (!shouldContinue()) {
    if (issued) await (await import("@/lib/bridge-installations")).revokeBridgeInstallationKey({ data: { orgId: context.org.id, installationId: issued.installationId } });
    return status;
  }

  return startDesktopBridge({
    site: window.location.origin,
    org: slug,
    // Blank asks the native engine to reuse its saved key for this exact site/org.
    key: issued?.key ?? "",

  });
}
