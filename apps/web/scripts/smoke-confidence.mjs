// Real-browser check of the production renderer/editor, with a simulated native
// output adapter. Does not start venue hardware or write organization settings.
// Run: node apps/web/scripts/smoke-confidence.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const web = resolve(import.meta.dirname, "..");
const fixture = mkdtempSync(join(web, ".confidence-smoke-"));
const session = `confidence-${process.pid}`;
const run = promisify(execFile);
async function browser(...args) {
  const { stdout } = await run("agent-browser", ["--session", session, "--json", ...args]);
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, result.error);
  return result.data;
}
writeFileSync(join(fixture, "native.ts"), `
let active = null;
export const isDesktopRuntime = () => true;
export async function invoke(command, args) {
  if (command === 'confidence_outputs') return {
    monitors: [{ id: 'stage', name: 'Stage display', width: 1920, height: 1080 }],
    decklink: { devices: [], error: null }, active,
  };
  if (command === 'confidence_output_status') return { state: active ? 'running' : 'stopped', message: active ? 'Stage output running' : 'Output disabled' };
  if (command === 'start_confidence_output') active = { orgSlug: args.orgSlug, target: args.target, label: 'Stage', ready: true };
  if (command === 'stop_confidence_output') active = null;
}
`);
writeFileSync(join(fixture, "settings.ts"), `
export const getManageableOrgSettings = async () => ({});
export const updateOrgSetting = async ({ data }) => { window.savedLayout = JSON.parse(data.value); return data; };
`);
writeFileSync(join(fixture, "index.html"), '<html class="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/main.tsx"></script></html>');
writeFileSync(join(fixture, "fixture.css"), '@import "../src/styles.css"; @source "../src"; @source "./main.tsx";');
writeFileSync(join(fixture, "main.tsx"), `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfidenceToolbar } from '@/components/confidence/ConfidenceToolbar';
import { ConfidenceSlide } from '@/components/confidence/ConfidenceSlide';
import { DEFAULT_CONFIDENCE_LAYOUT } from '@/lib/confidence-layout';
import './fixture.css';
function App() {
  const [index, setIndex] = useState(0);
  const [scripture, setScripture] = useState(false);
  const [nextSize, setNextSize] = useState(1);
  const texts = ['Amazing grace, how sweet the sound\\nThat saved a wretch like me', 'I once was lost, but now am found\\nWas blind, but now I see', 'Hallelujah', 'A long upcoming lyric that should stay readable instead of shrinking. '.repeat(20), Array(12).fill('Another line of the upcoming lyric').join('\\n'), 'Hallelujah'.repeat(40), ''];
  const slide = { text: scripture ? 'John 3:16\\nKJV\\nFor God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.' : texts[index % texts.length], nextText: scripture ? 'John 3:17\\nKJV\\nFor God sent not his Son into the world to condemn the world; but that the world through him might be saved.' : texts[(index + 1) % texts.length], notes: '', presentationName: '', isScripture: false };
  return <main className="bg-board-bg text-board-text p-4">
    <div className="flex flex-wrap items-center gap-3"><ConfidenceToolbar slug="demo" orgId="demo" /><button id="advance" onClick={() => setIndex(i => i + 1)}>Advance</button><button id="scripture" onClick={() => setScripture(s => !s)}>Scripture</button></div>
    <button id="size" onClick={() => setNextSize(s => s === 1 ? 1.8 : 1)}>Upcoming size</button>
    <div id="output" className="mt-4 aspect-video bg-black p-[4%]" style={{ containerType: 'inline-size' }}><ConfidenceSlide slide={slide} layout={{ ...DEFAULT_CONFIDENCE_LAYOUT, lyrics: { ...DEFAULT_CONFIDENCE_LAYOUT.lyrics, nextSize }, scripture: { ...DEFAULT_CONFIDENCE_LAYOUT.scripture, showNext: true, nextSize }, motion: 'none' }} /></div>
  </main>;
}
createRoot(document.getElementById('root')).render(<App />);
`);
const server = await createServer({
  configFile: false, root: fixture, plugins: [react(), tailwind()],
  resolve: { alias: [
    { find: "@/lib/settings", replacement: join(fixture, "settings.ts") },
    { find: "@/lib/desktop-runtime", replacement: join(fixture, "native.ts") },
    { find: "@tauri-apps/api/core", replacement: join(fixture, "native.ts") },
    { find: "@", replacement: join(web, "src") },
  ] },
  server: { host: "127.0.0.1", port: 3198, strictPort: true, fs: { allow: [resolve(web, "../.."), fixture] } },
});
const results = [];
try {
  await server.listen();
  await browser("open", "http://127.0.0.1:3198");
  await browser("wait", "[data-confidence-next]");
  await browser("click", "#scripture");
  await browser("click", '#size');
  assert.equal((await browser("eval", `(() => { const next = document.querySelector('[data-confidence-next]'); return next.getBoundingClientRect().height > next.parentElement.clientHeight + 1; })()`)).result, false, 'Scripture preview and reference must fit at maximum upcoming size');
  await browser("click", '#size');
  await browser("click", "#scripture");
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1280, 600], [1920, 1080], [2560, 1440], [3440, 1440]]) {
    await browser("set", "viewport", String(width), String(height));
    const sizes = [];
    for (let i = 0; i < 14; i++) {
      if (i === 7) await browser("click", "#size");
      const { result } = await browser("eval", `(() => {
        const next = document.querySelector('[data-confidence-next]');
        const current = document.querySelector('[data-confidence-current]');
        return { size: parseFloat(getComputedStyle(next).fontSize), weight: getComputedStyle(next).fontWeight, currentWeight: getComputedStyle(current).fontWeight,
          overflow: next.scrollHeight > next.parentElement.clientHeight + 1 || next.scrollWidth > next.parentElement.clientWidth + 1,
          pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      })()`);
      assert.equal(result.overflow, false);
      assert.equal(result.pageOverflow, false);
      assert.equal(result.weight, result.currentWeight);
      sizes.push(result.size);
      await browser("click", "#advance");
    }
    for (const group of [sizes.slice(0, 7), sizes.slice(7)]) {
      assert.ok(Math.max(...group) - Math.min(...group) < 0.5, `Next font changed at ${width}: ${group}`);
    }
    assert.ok(Math.abs(sizes[7] / sizes[0] - 1.8) < 0.01, 'Upcoming size control must still apply');
    await browser("click", "#size");
    if (width === 1280) await browser("screenshot", "/tmp/showpilot-confidence-toolbar-fixed.png");
    await browser("click", '[aria-label="Confidence output and appearance"]');
    await browser("wait", '[role="dialog"] input[type="color"]');
    const { result: bounds } = await browser("eval", `(() => { const el = document.querySelector('[role="dialog"]'); const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, overflow:el.scrollWidth > el.clientWidth + 1 }; })()`);
    assert.ok(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1, JSON.stringify(bounds));
    assert.equal(bounds.overflow, false);
    await browser("click", '[data-slot="dialog-close"]');
    results.push({ width, height, nextFontSize: sizes[0], passed: true });
  }
  await browser("click", '#scripture');
  assert.equal((await browser("eval", "document.querySelector('[data-confidence-reference]').textContent")).result, "John 3:16 KJV");
  assert.ok(!(await browser("eval", "document.querySelector('[data-confidence-current]').textContent")).result.includes("KJV"));
  await browser("screenshot", "/tmp/showpilot-scripture-fixed.png");
  await browser("click", '[aria-label="Confidence output and appearance"]');
  await browser("select", 'select:has(option[value="monitor:stage"])', "monitor:stage");
  await browser("find", "role", "button", "click", "--name", "Enable output", "--exact");
  await browser("wait", "text=Stage output running");
  await browser("eval", `(() => { const el = document.querySelector('[aria-label="Upcoming text color"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '#33ccff'); el.dispatchEvent(new Event('input', { bubbles:true })); el.dispatchEvent(new Event('change', { bubbles:true })); })()`);
  await browser("find", "role", "button", "click", "--name", "Apply to screens", "--exact");
  await browser("wait", "text=Applied. Open screens will update within a few seconds.");
  assert.equal((await browser("eval", "window.savedLayout.lyrics.nextColor")).result, "#33ccff");
  await browser("screenshot", "/tmp/showpilot-confidence-controls.png");
  console.log(JSON.stringify({ viewports: results, scripture: "passed", outputToggle: "passed", savedNextColor: "passed" }, null, 2));
} finally {
  await browser("close").catch(() => {});
  await server.close();
  rmSync(fixture, { recursive: true, force: true });
}
