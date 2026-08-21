import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { isDesktopRuntime, startDesktopBridge } from "@/lib/desktop-runtime";
import { getOrgRouteContext } from "@/lib/session";
import { getOrgSettings } from "@/lib/settings";

/**
 * Keeps the native device engine configured independently of the visible route.
 * Display routes do not render AppShell, so this belongs at the router root.
 */
export function DesktopBridgeController() {
  const { slug } = useParams({ strict: false });

  useEffect(() => {
    if (!isDesktopRuntime() || !slug) return;
    let active = true;

    const bootstrap = async () => {
      try {
        const context = await getOrgRouteContext({ data: slug });
        if (!active || !context) return;
        const settings = await getOrgSettings({ data: { orgId: context.org.id } });
        const key = settings["api-key"];
        if (!key) return;
        await startDesktopBridge({
          site: window.location.origin,
          org: slug,
          key,
          propresenterHost: settings["propresenter-host"] || undefined,
          propresenterPort: positivePort(settings["propresenter-port"]),
          propresenterApiPort: positivePort(settings["propresenter-api-port"]),
          propresenterPassword: settings["propresenter-password"] || undefined,
        });
      } catch (cause) {
        // The status bar reports native engine errors on authenticated app routes.
        console.error("Unable to configure the desktop device engine", cause);
      }
    };

    void bootstrap();
    return () => {
      active = false;
    };
  }, [slug]);

  return null;
}

function positivePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}
