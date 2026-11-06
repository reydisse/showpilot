import {
  getDesktopBridgeStatus,
  isDesktopLocalDeviceMode,
  startDesktopBridge,
  type DesktopBridgeStatus,
} from "@/lib/desktop-runtime";
import { getOrgRouteContext } from "@/lib/session";
import { getDesktopBridgeSettings } from "@/lib/settings";
import { createBridgeInstallation, revokeBridgeInstallationKey } from "@/lib/bridge-installations";

function positivePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/**
 * Starts this Desktop's embedded Bridge only after local-device mode has been
 * explicitly enabled. Remote operators must keep venue-Bridge mode selected,
 * otherwise their unreachable local agent would replace the venue agent.
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
  const settings = await getDesktopBridgeSettings({ data: { orgId: context.org.id } });
  if (!shouldContinue()) return status;
  const issued = !sameInstallation || status.connection === "unauthorized"
    ? await createBridgeInstallation({ data: { orgId: context.org.id, label: "ShowPilot Desktop" } })
    : null;
  if (!shouldContinue()) {
    if (issued) await revokeBridgeInstallationKey({ data: { orgId: context.org.id, installationId: issued.installationId } });
    return status;
  }

  return startDesktopBridge({
    site: window.location.origin,
    org: slug,
    // Blank asks the native engine to reuse its saved key for this exact site/org.
    key: issued?.key ?? "",
    propresenterHost: settings["propresenter-host"] || undefined,
    propresenterPort: positivePort(settings["propresenter-port"]),
    propresenterApiPort: positivePort(settings["propresenter-api-port"]),
    propresenterPassword: settings["propresenter-password"] || undefined,
  });
}
