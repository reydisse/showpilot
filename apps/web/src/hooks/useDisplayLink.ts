import { useEffect, useState } from "react";
import { createDisplayLink } from "@/lib/display-access";
import type { DisplaySurface } from "@/lib/display-access.server";

export function useDisplayLink(orgSlug: string, surface: DisplaySurface) {
  const [attempt, setAttempt] = useState(0);
  const [link, setLink] = useState<{ scope: string; url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = `${orgSlug}:${surface}`;
  useEffect(() => {
    let active = true;
    setLink(null); setError(null);
    void createDisplayLink({ data: { orgSlug, surface } }).then((created) => {
      if (active) setLink({ scope, url: new URL(created.path, window.location.origin).href, expiresAt: created.expiresAt });
    }).catch(() => { if (active) setError("Could not create a display link. Try again."); });
    return () => { active = false; };
  }, [orgSlug, surface, scope, attempt]);
  const current = link?.scope === scope ? link : null;
  return {
    url: current?.url ?? "", expiresAt: current?.expiresAt ?? null, error,
    refresh: () => setAttempt((value) => value + 1),
    copy: async () => {
      if (!current) return false;
      try { await navigator.clipboard.writeText(current.url); return true; }
      catch { setError("Copy failed. Select and copy the display link."); return false; }
    },
  };
}
