import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routePath = new URL("../src/routes/$slug/streaming/lt-preview.tsx", import.meta.url);
const graphicsPath = new URL("../src/lib/graphic-composition.ts", import.meta.url);

test("Template Studio separates Preview from Program and exposes the narrow inspector", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(source, /Preview · 16:9/);
  assert.match(source, /Program: \$\{activeIds\.length\} layers/);
  assert.match(source, /mobileControlsOpen/);
  assert.match(source, /<Dialog open=\{mobileControlsOpen\}/);
  assert.match(source, /grid gap-3 sm:grid-cols-2/);
  assert.doesNotMatch(source, /\{visible \? "On Air" : "Off Air"\}/);
});

test("scene and graphic saves are distinct and busy states always settle", async () => {
  const source = await readFile(routePath, "utf8");
  assert.match(source, /Save graphic/);
  assert.match(source, /Save scene/);
  assert.match(source, /getGraphicScenes/);
  assert.match(source, /saveGraphicScene/);
  assert.match(source, /finally \{\s*setSaving\(false\)/);
  assert.match(source, /finally \{\s*setPushing\(false\)/);
});

test("publication uses one immutable D1 batch rather than editing live templates", async () => {
  const route = await readFile(routePath, "utf8");
  const core = await readFile(graphicsPath, "utf8");
  assert.match(route, /publishGraphicComposition/);
  assert.doesNotMatch(route, /updateGraphicTemplate/);
  assert.doesNotMatch(route, /setActiveGraphics/);
  assert.match(core, /await db\.batch\(statements\)/);
  assert.match(core, /ON CONFLICT\(id\) DO NOTHING/);
});
