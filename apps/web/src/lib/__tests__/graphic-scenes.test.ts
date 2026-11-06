import { describe, expect, it } from "vitest";
import { DEFAULT_CONTROLS } from "../graphic-controls";
import { graphicSceneItemsSchema, readGraphicSceneRecord, restoreGraphicScene } from "../graphic-scenes";
const style = JSON.stringify({ templateId: "classic", controls: DEFAULT_CONTROLS });
const layer = { key: "one", name: "First", title: "First\nline", subtitle: "Speaker", style };
const scene = { id: "saved", name: "Panel", items: [layer, { ...layer, key: "two", title: "Second" }], createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z" };
const record = (value: unknown) => ({ id: "record", key: "graphic-scene:saved", value: JSON.stringify(value) });
const templates = new Set(["classic"]);
it("restores all layers in order with exact text and controls", () => {
  const restored = restoreGraphicScene(scene, templates);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw new Error(restored.message);
  expect(restored.layers.map(item => item.primary)).toEqual(["First\nline", "Second"]);
  expect(restored.layers[0].controls).toEqual(DEFAULT_CONTROLS);
  expect(readGraphicSceneRecord(record(scene))).toEqual({ status: "ready", recordId: "record", scene });
});
it("keeps damaged rows visible and uses the stored key when the embedded ID differs", () => {
  expect(readGraphicSceneRecord({ ...record(scene), value: "{" })).toEqual({ status: "unreadable", recordId: "record", id: "saved", name: "Unreadable scene" });
  expect(readGraphicSceneRecord(record({ ...scene, id: "another-scene" }))).toEqual({ status: "unreadable", recordId: "record", id: "saved", name: "Panel" });
});
describe("rejects the entire scene rather than returning a partial preview", () => {
  const badStyles = ["{", "{}", JSON.stringify({templateId:"classic",controls:{}}),
    ...[{primarySize:0},{secondarySize:100},{posX:-1},{posY:101},{bgOpacity:101},{accentColor:"url(https://invalid)"},{animSpeed:"unknown"},{primarySize:"46"}].map(patch => JSON.stringify({templateId:"classic",controls:{...DEFAULT_CONTROLS,...patch}}))];
  it.each(badStyles)("rejects damaged style %s", badStyle => {
    const damaged = { ...scene, items: [layer, { ...layer, key:"two", style:badStyle }] };
    expect(restoreGraphicScene(damaged, templates)).toMatchObject({ok:false});
    expect(readGraphicSceneRecord(record(damaged)).status).toBe("unreadable");
    expect(graphicSceneItemsSchema.safeParse(damaged.items).success).toBe(false);
  });
  it("rejects an unavailable renderer without returning the other valid layer", () => {
    const result=restoreGraphicScene({...scene,items:[layer,{...layer,key:"two",style:JSON.stringify({templateId:"future-template",controls:DEFAULT_CONTROLS})}]},templates);
    expect(result).toMatchObject({ok:false,message:expect.stringContaining("unavailable template")});
    expect(result).not.toHaveProperty("layers");
  });
  it("rejects duplicate layer keys and empty scenes", () => {
    expect(graphicSceneItemsSchema.safeParse([layer,layer]).success).toBe(false);
    expect(restoreGraphicScene({...scene,items:[]},templates).ok).toBe(false);
  });
});
