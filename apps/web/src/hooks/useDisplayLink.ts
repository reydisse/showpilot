import { useCallback, useEffect, useState } from "react";
import { createDisplayLink } from "@/lib/display-access";
import type { DisplaySurface } from "@/lib/display-access.server";
import { useOperatorRead } from "./useOperatorRead";

type DisplayLink = { url: string; expiresAt: number };
export function useDisplayLink(orgSlug: string, surface: DisplaySurface) {
  const scope = `${orgSlug}:${surface}`;
  const read = useCallback(async (signal: AbortSignal): Promise<DisplayLink | null> => {
    const created = await createDisplayLink({ data: { orgSlug, surface }, signal });
    if (created.expiresAt <= Date.now()) throw new Error("Display link expired before confirmation");
    return { url: new URL(created.path, window.location.origin).href, expiresAt: created.expiresAt };
  }, [orgSlug, surface]);
  const link = useOperatorRead({ key: scope, initialValue: null, read, errorMessage: "Could not create a display link. Try again." });
  const [copyError, setCopyError] = useState<{ scope: string; message: string; occurredAt: number } | null>(null);
  const [, updateExpiry] = useState(0);
  useEffect(() => {
    if (!link.value) return;
    const timer = setTimeout(() => updateExpiry(value => value + 1), Math.max(0, link.value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [link.value]);
  const expired = link.value !== null && link.value.expiresAt <= Date.now();
  const current = link.value && !expired ? link.value : null;
  let monitorUrl = "";
  if (current) { const url = new URL(current.url); url.searchParams.set("monitor", "1"); monitorUrl = url.href; }
  const error = copyError?.scope === scope ? copyError : link.error;
  return {
    url: current?.url ?? "", monitorUrl, expiresAt: current?.expiresAt ?? null,
    pending: link.refreshing || (link.confirmedAt === null && !link.error), error: error?.message ?? (expired ? "This display link has expired. Create a fresh link." : null), errorAt: error?.occurredAt ?? null,
    refresh: () => { setCopyError(null); link.retry(); },
    copy: async () => {
      if (!current || current.expiresAt <= Date.now()) return false;
      try { await navigator.clipboard.writeText(current.url); setCopyError(previous => previous?.scope === scope ? null : previous); return true; }
      catch { setCopyError({ scope, message: "Copy failed. Select and copy the display link.", occurredAt: Date.now() }); return false; }
    },
  };
}
