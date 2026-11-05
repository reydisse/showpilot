import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, queryFixture, operatorCookie, operatorEmail, operatorPassword, stopServer, startServer }) => {
  const path = `${origin}/api/rundown/${orgId}`;
  const query = `showId=smoke-show&serviceDate=${date}`;
  const command = async (action, payload, showId = "smoke-show") => {
    const response = await fetch(`${path}/command?showId=${showId}&serviceDate=${date}`, { method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  };
  const state = async () => (await fetch(`${path}/state?${query}`, { headers: { Cookie: operatorCookie } })).json();
  const rows = () => queryFixture("SELECT id,itemId,title,sortOrder,length(notes) AS notesLength FROM rundown_item WHERE orgId='display-smoke' AND showId='smoke-show' ORDER BY sortOrder");
  const items = Array.from({ length: 150 }, (_, index) => ({ id: `cue-${index}`, title: `Cue ${index}`, type: "segment", duration: 60000, notes: "n".repeat(20000), assignee: "Fixture operator", cue: "", status: "upcoming", sortOrder: index, hardStop: false }));
  await command("seed", { items });
  await command("seed", { items: items.slice(0, 2).map(item => ({ ...item, notes: "" })), scheduledStartTime: `${date}T23:00:00.000Z` }, "smoke-second-show");
  const before = await rows();
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown?showId=smoke-show`);
  await browser("wait", "text=Cue 42");
  await browser("click", '.group:has(p:text-is("Cue 42")) button[title="Edit"]');
  await browser("fill", 'input[value="Cue 42"]', "Edited large rundown cue");
  await click("Save");
  await browser("wait", "text=Edited large rundown cue");
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await state()).items[42].title === "Edited large rundown cue") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const after = await rows();
  assert.equal(after[42].title, "Edited large rundown cue");
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
  assert.deepEqual(after.filter(row => row.itemId !== "cue-42"), before.filter(row => row.itemId !== "cue-42"));
  assert.deepEqual(await queryFixture("SELECT key FROM app_setting WHERE orgId='display-smoke' AND key='rundown-items:smoke-show'"), []);
  await command("pp-output-enabled", { enabled: true });
  await command("pp-preview", { slide: { text: "Persistent lyrics", notes: "", presentationName: "Test song", isScripture: false } });
  await stopServer();
  await startServer();
  const recovered = await state();
  assert.equal(recovered.items.length, 150);
  assert.equal(recovered.items[42].title, "Edited large rundown cue");
  assert.equal(recovered.ppSlide.text, "Persistent lyrics");
  await browser("open", `${origin}/${orgId}/rundown?showId=smoke-show`);
  await browser("wait", "text=Edited large rundown cue");
  // The PM loader must still render after item summaries move to relational rows.
  await browser("open", `${origin}/${orgId}/dashboard/prod-manager`);
  assert.equal((await browser("eval", "document.body.innerText.includes('Something went wrong')")).result, false);
  assert.ok((await browser("eval", "document.body.innerText.includes('Display test show')")).result);
  await browser("wait", "text=Evening test show · 2 items");
  console.log(JSON.stringify({ login: "passed", threeMegabyteTimeline: "passed", browserEdit: "passed", unchangedRowIds: "passed", noJsonItemSnapshot: "passed", workerRestartRestoresItemsAndLyrics: "passed", pmDashboardLoadsFromRows: "passed" }, null, 2));
}, { secondShow: true });
