import { z } from "zod";
import { idSchema, labelSchema } from "./validation";
import { graphicControlsSchema, type Controls } from "./graphic-controls";

const sceneStyleSchema = z.object({ templateId: idSchema, controls: graphicControlsSchema });
function readStyle(value: string) {
  try { return sceneStyleSchema.safeParse(JSON.parse(value)); }
  catch { return sceneStyleSchema.safeParse(null); }
}
const sceneItemSchema = z.object({
  key: idSchema, name: labelSchema, title: z.string().max(500), subtitle: z.string().max(500),
  style: z.string().max(20_000).refine(value => readStyle(value).success, "Scene layer styling is unreadable"),
});
export const graphicSceneItemsSchema = z.array(sceneItemSchema).min(1).max(50).refine(
  items => new Set(items.map(item => item.key)).size === items.length, "Scene layers must have distinct keys",
);
export const savedGraphicSceneSchema = z.object({
  id: idSchema, name: labelSchema, items: graphicSceneItemsSchema,
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type SavedGraphicScene = z.infer<typeof savedGraphicSceneSchema>;
export type GraphicSceneEntry =
  | { status: "ready"; recordId: string; scene: SavedGraphicScene }
  | { status: "unreadable"; recordId: string; id: string | null; name: string };
export interface PreviewSceneLayer { key: string; templateId: string; primary: string; secondary: string; controls: Controls }

/** Keep damaged rows visible and address deletion by their stored key, never by corrupt content. */
export function readGraphicSceneRecord(row: { id: string; key: string; value: string }): GraphicSceneEntry {
  const id = idSchema.safeParse(row.key.slice("graphic-scene:".length));
  let value: unknown;
  try { value = JSON.parse(row.value); } catch { value = null; }
  const scene = savedGraphicSceneSchema.safeParse(value);
  if (id.success && scene.success && scene.data.id === id.data) return { status: "ready", recordId: row.id, scene: scene.data };
  const label = z.object({ name: labelSchema }).safeParse(value);
  return { status: "unreadable", recordId: row.id, id: id.success ? id.data : null, name: label.success ? label.data.name : "Unreadable scene" };
}

/** Validate every layer before returning any replacement for the current preview. */
export function restoreGraphicScene(value: unknown, templateIds: ReadonlySet<string>):
  { ok: true; scene: SavedGraphicScene; layers: PreviewSceneLayer[] } | { ok: false; message: string } {
  const scene = savedGraphicSceneSchema.safeParse(value);
  if (!scene.success) return { ok: false, message: "This scene contains unreadable layers. Preview and Program were kept. Refresh the library before loading it again." };
  const layers: PreviewSceneLayer[] = [];
  for (const item of scene.data.items) {
    const style = readStyle(item.style);
    if (!style.success || !templateIds.has(style.data.templateId)) return { ok: false, message: "A saved layer uses an unavailable template. Preview and Program were kept. Refresh the library before loading it again." };
    layers.push({ key: item.key, templateId: style.data.templateId, primary: item.title, secondary: item.subtitle, controls: style.data.controls });
  }
  return { ok: true, scene: scene.data, layers };
}
