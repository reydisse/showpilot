import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("every cockpit range control commits keyboard changes", () => {
  const source = read("../src/components/devices/CockpitControlPanel.tsx");
  for (const label of ["Channel ${channel} fader", "Display volume", "Lighting master intensity"]) {
    const position = source.indexOf(`aria-label={\`${label}\``) >= 0
      ? source.indexOf(`aria-label={\`${label}\``)
      : source.indexOf(`aria-label="${label}"`);
    assert.ok(position >= 0, `${label} slider not found`);
    assert.match(source.slice(position, position + 700), /onKeyUp=/, `${label} has no keyboard commit`);
  }
});

test("tap-to-mark leaves form controls and contenteditable targets alone", () => {
  const source = read("../src/routes/$slug/songs.$songId.tsx");
  assert.match(source, /target\.matches\("input, textarea, select, button"\)/);
  assert.match(source, /target\.isContentEditable/);
});

test("song drafts have one save-all path and block destructive navigation", () => {
  const route = read("../src/routes/$slug/songs.$songId.tsx");
  const server = read("../src/lib/songs.ts");
  assert.match(route, /useBlocker\(\{/);
  assert.match(route, /Save all changes/);
  assert.match(route, /Save and leave/);
  assert.match(route, /Discard drafts and update from ProPresenter/);
  assert.match(route, /reconcileSavedSection/);
  assert.match(server, /export const saveSongDraft/);
  assert.match(server, /await prisma\.\$transaction\(\[/);
});
