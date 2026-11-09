import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { configureDesktopLocalDevices } from "@/lib/desktop-local-devices";
import { getDesktopActions } from "@/lib/desktop-operations";
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

    getDesktopActions().bridge.start("Local devices", async withinDeadline => {
      await configureDesktopLocalDevices(slug, false, () => active && withinDeadline());
    });
    return () => {
      active = false;
    };
  }, [slug]);

  return null;
}
