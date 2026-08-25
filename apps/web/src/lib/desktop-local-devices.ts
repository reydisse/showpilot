import {
  getDesktopBridgeStatus,
  startDesktopBridge,
  type DesktopBridgeStatus,
} from "@/lib/desktop-runtime";
import { getOrgRouteContext } from "@/lib/session";
import { getDesktopBridgeSettings } from "@/lib/settings";

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
  if (!forceEnable && !status.localDevicesEnabled) return status;

  const context = await getOrgRouteContext({ data: slug });
  if (!context) throw new Error("Sign in before enabling local devices");
  const settings = await getDesktopBridgeSettings({ data: { orgId: context.org.id } });
  if (!shouldContinue()) return status;
  const key = settings["api-key"]?.trim();
  if (!key) {
    throw new Error("Ask an owner or admin to create the Bridge API key in Settings first");
  }

  return startDesktopBridge({
    site: window.location.origin,
    org: slug,
    key,
    propresenterHost: settings["propresenter-host"] || undefined,
    propresenterPort: positivePort(settings["propresenter-port"]),
    propresenterApiPort: positivePort(settings["propresenter-api-port"]),
    propresenterPassword: settings["propresenter-password"] || undefined,
  });
}
