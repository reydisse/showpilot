import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { useOperatorRead } from "@/hooks/useOperatorRead";
import { graphicControlsSchema, DEFAULT_CONTROLS } from "@/lib/graphic-controls";
import { getTemplate, TEMPLATES, LtStage } from "@/lib/lt-templates";

const styleSchema = z.object({ templateId: z.string().optional(), controls: graphicControlsSchema.partial().optional() });
const graphicSchema = z.object({ id: z.string().min(1), title: z.string(), subtitle: z.string().nullish(), style: z.string().nullish() });
const graphicsSchema = z.array(graphicSchema).refine(items => new Set(items.map(item => item.id)).size === items.length);
function parseGraphics(value: unknown) {
  return graphicsSchema.parse(value).map(graphic => {
    const style = styleSchema.parse(graphic.style ? JSON.parse(graphic.style) : {});
    if (style.templateId && !TEMPLATES.some(template => template.id === style.templateId)) throw new Error("Unavailable graphic template");
    return { ...graphic, templateId: style.templateId, controls: { ...DEFAULT_CONTROLS, ...style.controls } };
  });
}
type Graphic = ReturnType<typeof parseGraphics>[number];
type Feed = { status: "ready"; graphics: Graphic[] } | { status: "unavailable" };
const EMPTY_FEED: Feed = { status: "ready", graphics: [] };
interface Slot { graphic: Graphic; active: boolean }

export function OverlayOutput({ orgSlug, monitor, retryAccess }: { orgSlug: string; monitor: boolean; retryAccess: () => void }) {
  const read = useCallback(async (signal: AbortSignal): Promise<Feed> => {
    const response = await fetch(`/api/overlay/${encodeURIComponent(orgSlug)}`, { signal, cache: "no-store" });
    if ([401, 403, 404].includes(response.status)) return { status: "unavailable" };
    if (!response.ok) throw new Error("Overlay read failed");
    return { status: "ready", graphics: parseGraphics(await response.json()) };
  }, [orgSlug]);
  const [unavailable, setUnavailable] = useState(false);
  const feed = useOperatorRead({ key: orgSlug, initialValue: EMPTY_FEED, read, intervalMs: 500, pauseWhenHidden: false,
    enabled: !unavailable, errorMessage: "Overlay connection lost. Keeping the last confirmed output while reconnecting." });
  useEffect(() => { if (feed.value.status === "unavailable") setUnavailable(true); }, [feed.value]);
  const message = unavailable ? "Display unavailable" : feed.error ? "Overlay reconnecting" : feed.confirmedAt === null ? "Connecting overlay" : "Overlay connected";
  useEffect(() => {
    const original = document.title;
    document.title = `${message}${feed.error ? ` · ${new Date(feed.error.occurredAt).toLocaleTimeString()}` : ""} | ShowPilot`;
    return () => { document.title = original; };
  }, [message, feed.error]);

  if (unavailable || feed.value.status === "unavailable") return <main className="flex min-h-screen items-center justify-center bg-black p-6 text-white">
    <div className="max-w-md space-y-4 text-center"><p role="alert">This display is unavailable. Sign in or ask an operator for a new display link.</p>
      <button type="button" onClick={retryAccess} className="min-h-11 rounded border border-white/30 px-4 outline-none focus-visible:ring-2 focus-visible:ring-white">Check display access</button>
    </div>
  </main>;
  return <div className="fixed inset-0 flex flex-col">
    {monitor && <aside aria-label="Overlay connection" className="z-50 flex shrink-0 flex-wrap items-center gap-3 border-b border-white/20 bg-black/90 p-3 text-sm text-white">
      <div className="min-w-0 flex-1"><p role={feed.error ? "alert" : "status"}>{feed.error?.message ?? message}</p>
        {feed.error && <p className="mt-1 text-xs text-white/70">Last error <time dateTime={new Date(feed.error.occurredAt).toISOString()}>{new Date(feed.error.occurredAt).toLocaleTimeString()}</time></p>}
        <p className="mt-1 text-xs text-white/70">Monitor view. Use the clean display link in OBS or vMix.</p>
      </div>
      {feed.error && <button type="button" onClick={feed.retry} disabled={feed.refreshing} className="min-h-11 shrink-0 rounded border border-white/30 px-4 outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60">{feed.refreshing ? "Retrying…" : "Retry overlay"}</button>}
    </aside>}
    <div className="overlay-container" data-connection-state={feed.error ? "reconnecting" : feed.confirmedAt === null ? "connecting" : "connected"} data-last-error-at={feed.error?.occurredAt}>
      <GraphicLayers graphics={feed.value.graphics} />
    </div>
  </div>;
}

function GraphicLayers({ graphics }: { graphics: Graphic[] }) {
  const [slots, setSlots] = useState<Slot[]>([]);
  useEffect(() => {
    const incoming = new Set(graphics.map(graphic => graphic.id));
    setSlots(previous => [
      ...previous.filter(slot => !incoming.has(slot.graphic.id)).map(slot => ({ ...slot, active: false })),
      ...graphics.map(graphic => ({ graphic, active: true })),
    ]);
  }, [graphics]);
  const removeExited = useCallback((id: string) => setSlots(previous => previous.filter(slot => slot.graphic.id !== id || slot.active)), []);
  return <LtStage>{slots.map(slot => <GraphicLayer key={slot.graphic.id} {...slot} removeExited={removeExited} />)}</LtStage>;
}

function GraphicLayer({ graphic, active, removeExited }: Slot & { removeExited: (id: string) => void }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let firstFrame: number | undefined; let secondFrame: number | undefined; let exit: ReturnType<typeof setTimeout> | undefined;
    if (active) firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => setVisible(true)); });
    else { setVisible(false); exit = setTimeout(() => removeExited(graphic.id), 650); }
    return () => { if (firstFrame !== undefined) cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame); clearTimeout(exit); };
  }, [active, graphic.id, removeExited]);
  return <div data-overlay-graphic={graphic.id}>{getTemplate(graphic.templateId).render(graphic.title, graphic.subtitle ?? "", visible, graphic.controls)}</div>;
}
