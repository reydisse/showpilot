import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, queryFixture, operatorCookie, operatorEmail, operatorPassword, stopServer, startServer }) => {
  const command = async (showId, action, payload) => {
    const response = await fetch(`${origin}/api/rundown/${orgId}/command?showId=${showId}&serviceDate=${date}`, {
      method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }),
    });
    assert.equal(response.status, 200); return response.json();
  };
  const item = title => ({ id: "cue", title, type: "segment", duration: 60000, notes: "", assignee: "", cue: "", status: "upcoming", sortOrder: 0, hardStop: false });
  await command("smoke-show", "seed", { items: [item("Morning cue")] });
  await command("smoke-second-show", "seed", { items: [item("Evening cue")] });
  const pointer = async () => Object.fromEntries((await queryFixture("SELECT key,value FROM app_setting WHERE orgId='display-smoke' AND key IN ('active-show-id','active-service-date')")).map(row => [row.key, row.value]));
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/rundown?show=smoke-second-show&date=${date}`);
  await browser("wait", "text=Evening cue");
  assert.equal((await pointer())["active-show-id"], "smoke-show", "Browsing must not switch outputs");
  const takeLive = async () => {
    await browser("find", "role", "button", "click", "--name", "Take live", "--exact");
    await browser("wait", '[role="dialog"]');
    await browser("click", '[role="dialog"] button:text-is("Take live")');
  };
  await browser("network", "route", "**/_serverFn/**", "--abort");
  await takeLive();
  await browser("wait", "text=Failed to fetch");
  assert.equal((await pointer())["active-show-id"], "smoke-show", "Failed activation must preserve the previous target");
  await browser("network", "unroute", "**/_serverFn/**");
  await takeLive();
  await browser("wait", "text=Live output");
  assert.deepEqual(await pointer(), { "active-show-id": "smoke-second-show", "active-service-date": date });
  const started = await command("smoke-show", "timer-start", { itemId: "cue" });
  assert.equal(started.showId, "smoke-show");
  assert.equal(started.serviceDate, date);
  assert.equal((await pointer())["active-show-id"], "smoke-second-show", "Starting another show must not retarget outputs");
  await stopServer(); await startServer();
  await browser("open", `${origin}/${orgId}/rundown?show=smoke-second-show&date=${date}`);
  await browser("wait", "text=Evening cue");
  await browser("wait", "text=Live output");
  assert.deepEqual(await pointer(), { "active-show-id": "smoke-second-show", "active-service-date": date });
  console.log(JSON.stringify({ login: "passed", browsingPreservesTarget: "passed", failedActivationVisible: "passed", confirmedTakeLive: "passed", timerCannotRetarget: "passed", restartRecovery: "passed" }, null, 2));
}, { secondShow: true });
