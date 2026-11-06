// Built app -> real authenticated rundown relay. No production data.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, operatorCookie, operatorEmail, operatorPassword }) => {
  const endpoint = `${origin}/api/rundown/${orgId}`;
  const query = `showId=smoke-show&serviceDate=${date}`;
  const command = async (action, payload) => {
    const response = await fetch(`${endpoint}/command?${query}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  };
  const state = async () => {
    const response = await fetch(`${endpoint}/state?${query}`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200); return response.json();
  };
  const evaluate = async expression => (await browser("eval", expression)).result;
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  const fillDialogTitle = async value => {
    const id = await evaluate(`[...document.querySelectorAll('[role="dialog"] label')].find(label => label.textContent.trim() === 'Title').htmlFor`);
    await browser("fill", `[id="${id}"]`, value);
  };
  const row = id => `[data-rundown-item-id="${id}"]`;
  for (const [id, title, type] of [["section", "Opening section", "header"], ["first", "Welcome", "segment"], ["last", "LongUnbrokenTitle".repeat(10), "song"]]) {
    await command("add-item", { id, title, type, duration: 300000, notes: "Long notes ".repeat(15), assignee: "Production team", cue: "", hardStop: false });
  }
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail); await browser("fill", "#password", operatorPassword);
  await click("Sign in"); await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/songs`);
  await browser("press", "Tab");
  assert.equal(await evaluate("document.activeElement.textContent"), "Skip to rundown");
  await browser("press", "Enter");
  await browser("wait", "--fn", "document.activeElement?.id === 'rundown-runsheet'");
  await browser("wait", row("last"));
  if (await evaluate("[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Dismiss shortcuts')")) await click("Dismiss shortcuts");

  for (const [width, height] of [[320, 480], [768, 900], [1024, 768], [1440, 900], [2560, 1200]]) {
    await browser("set", "viewport", String(width), String(height));
    await browser("scrollintoview", row("last"));
    const layout = await evaluate(`(() => {
      const sheet = document.querySelector('#rundown-runsheet'); const page = document.querySelector('.rundown-page');
      return { width: innerWidth, pageFits: page.scrollWidth <= page.clientWidth + 1, sheetFits: sheet.scrollWidth <= sheet.clientWidth + 1,
        rows: [...sheet.querySelectorAll('[data-rundown-item-id]')].map(row => ({ id: row.dataset.rundownItemId, fits: row.scrollWidth <= row.clientWidth + 1,
          buttons: [...row.querySelectorAll('button')].map(button => { const box = button.getBoundingClientRect(); return { label: button.getAttribute('aria-label'), width: box.width, height: box.height, fits: box.left >= 0 && box.right <= innerWidth + 1, opacity: getComputedStyle(button.parentElement).opacity, shared: button.dataset.slot === 'button' }; }) })) };
    })()`);
    assert.ok(layout.pageFits && layout.sheetFits, JSON.stringify(layout));
    for (const entry of layout.rows) {
      assert.ok(entry.fits, JSON.stringify(entry));
      for (const button of entry.buttons) assert.ok(button.width >= 44 && button.height >= 44 && button.fits && button.opacity === "1" && button.shared, JSON.stringify(button));
    }
    await browser("screenshot", `/tmp/showpilot-rundown-layout-${width}.png`);
  }
  await browser("set", "viewport", "1440", "900");
  await browser("focus", `${row("first")} button[title="Move down"]`);
  await browser("press", "Enter");
  await poll(async () => (await state()).items.at(-1)?.id === "first", "keyboard move down");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Move up Welcome");
  await browser("press", "Enter");
  await poll(async () => (await state()).items[1]?.id === "first", "keyboard move up");
  const focus = await evaluate("({ visible: document.activeElement.matches(':focus-visible'), shadow: getComputedStyle(document.activeElement).boxShadow })");
  assert.ok(focus.visible && focus.shadow !== "none", JSON.stringify(focus));
  await browser("screenshot", "/tmp/showpilot-rundown-keyboard-focus.png");
  await browser("drag", `${row("first")} button[draggable]`, row("last"));
  await poll(async () => (await state()).items.at(-1)?.id === "first", "native drag from button handle");
  await browser("focus", `${row("first")} button[title="Start"]`);
  await browser("press", "Space");
  await poll(async () => { const value = await state(); return value.timer.playback === "play" && value.timer.currentItemId === "first"; }, "keyboard row Start");
  await browser("wait", "--fn", `document.querySelector(${JSON.stringify(row("first"))}).textContent.includes('Welcome')`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(`${row("first")} .rundown-row-actions`)})).opacity`), "1");
  await browser("set", "viewport", "320", "480");
  await browser("scrollintoview", `${row("first")} button[title="Edit"]`);
  await browser("click", `${row("first")} button[title="Edit"]`);
  await browser("wait", "text=Edit Item");
  const checkDialog = async () => {
    const bounds = await evaluate(`(() => { const dialog = document.querySelector('[role="dialog"]'); const r = dialog.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: innerWidth, height: innerHeight, fits: dialog.scrollWidth <= dialog.clientWidth + 1, focused: dialog.contains(document.activeElement) }; })()`);
    assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height + 1 && bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.fits && bounds.focused, JSON.stringify(bounds));
  };
  await checkDialog();
  await browser("screenshot", "/tmp/showpilot-rundown-edit-320.png");
  await fillDialogTitle("Welcome updated");
  await click("Save");
  await poll(async () => (await state()).items.find(item => item.id === "first")?.title === "Welcome updated", "narrow edit saved");
  assert.equal((await state()).timer.currentItemId, "first");
  await click("Add item");
  await browser("wait", "text=Add rundown item");
  await checkDialog();
  await fillDialogTitle("Closing section");
  await click("Section");
  await click("Add");
  await poll(async () => (await state()).items.some(item => item.title === "Closing section" && item.type === "header" && item.duration === 0), "narrow section saved");
  await click("Rundown actions");
  await browser("find", "role", "menuitem", "click", "--name", "Save as template", "--exact");
  await browser("wait", "text=Save Rundown Template");
  await checkDialog(); await click("Cancel");
  await click("Rundown actions");
  await browser("find", "role", "menuitem", "click", "--name", "Load from date or template", "--exact");
  await browser("wait", "text=Load Rundown");
  await checkDialog();
  await browser("focus", 'button:text-is("Saved Templates")'); await browser("press", "Enter");
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-pressed')"), "true");
  await browser("press", "Escape");
  await browser("wait", "--fn", "document.querySelector('[role=dialog]') === null");
  await click("Show options");
  await browser("wait", '[role="dialog"]'); await checkDialog();
  await click("Create another show");
  await browser("wait", 'text=New show'); await checkDialog();
  await browser("screenshot", "/tmp/showpilot-rundown-new-show-320.png");
  await click("Cancel");
  await browser("wait", "--fn", "document.querySelector('[role=dialog]') === null");
  console.log(JSON.stringify({ passed: true, skipLinkCrossRouteFocus: true, fiveViewportLayouts: true, minimum44pxRows: true, rowActionsAlwaysVisible: true, keyboardReorderPersists: true, focusRingVisible: true, dragReorderPersists: true, keyboardStart: true, narrowEditAndSectionSaved: true, allSixDialogsFitAndFocus: true, plainTabButtonsKeyboard: true }));
});
