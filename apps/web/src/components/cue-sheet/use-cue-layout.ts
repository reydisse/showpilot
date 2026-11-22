import { useCallback, useEffect, useRef, useState } from "react";

export interface CueLayout { hidden: string[]; collapsed: string[]; focus: string | null; tabletShown: string[]; customCollapsed: boolean }
const defaults: CueLayout = { hidden: ["owner"], collapsed: [], focus: null, tabletShown: [], customCollapsed: false };
function readLayout(raw: string | null): CueLayout {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return defaults;
    const p = value as Record<string, unknown>;
    const list = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
    return { hidden: list(p.hidden), collapsed: list(p.collapsed), focus: typeof p.focus === "string" ? p.focus : null, tabletShown: list(p.tabletShown), customCollapsed: p.customCollapsed === true };
  } catch { return defaults; }
}

/** Visibility, collapse and focus are personal; width and order remain org data. */
export function useCueLayout(orgId: string, userId: string) {
  const key = `showpilot:cue-layout:v1:${orgId}:${userId}`;
  const [stored, setStored] = useState<{ key: string; layout: CueLayout } | null>(null);
  const [compact, setCompact] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const latest = useRef<{ key: string; layout: CueLayout }>({ key, layout: defaults });
  const layout = stored?.key === key ? stored.layout : defaults;
  latest.current = { key, layout };
  useEffect(() => {
    let layout = defaults;
    try { layout = readLayout(localStorage.getItem(key)); } catch { /* Storage may be disabled. */ }
    latest.current = { key, layout }; setStored({ key, layout });
  }, [key]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const phone = window.matchMedia("(max-width: 700px)");
    const update = () => { setCompact(media.matches); setNarrow(phone.matches); };
    update(); media.addEventListener("change", update); phone.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); phone.removeEventListener("change", update); };
  }, []);
  const update = useCallback((change: (layout: CueLayout) => CueLayout) => {
    const before = latest.current.key === key ? latest.current.layout : defaults;
    const next = change(before);
    latest.current = { key, layout: next }; setStored({ key, layout: next });
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the view usable for this visit. */ }
  }, [key]);
  return { layout, compact, narrow, update };
}
