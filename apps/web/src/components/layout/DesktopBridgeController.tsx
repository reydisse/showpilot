import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { configureDesktopLocalDevices } from "@/lib/desktop-local-devices";
import { isDesktopRuntime } from "@/lib/desktop-runtime";

/**
 * Restores an explicitly enabled local device engine independently of the
 * visible route. Venue-Bridge mode is intentionally inert so remote Desktop
 * operators cannot replace the production computer's active Bridge.
 */
export function DesktopBridgeController() {
  const { slug } = useParams({ strict: false });

  useEffect(() => {
    if (!isDesktopRuntime() || !slug) return;
    let active = true;

    const bootstrap = async () => {
      try {
        await configureDesktopLocalDevices(slug, false, () => active);
        if (!active) return;
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
