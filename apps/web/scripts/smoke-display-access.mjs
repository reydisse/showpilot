// Run after the web build. Requires agent-browser; uses only disposable local data.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, date, browser, pass, operatorCookie }) => {
  for (const relay of ["rundown", "timecode", "bridge", "chat", "cue-sheet", "lowerthirds"]) {
    const response = await fetch(`${origin}/api/${relay}/${orgId}/internal/purge-org`, {
      method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "x-showpilot-internal-secret": "forged" },
    });
    assert.equal(response.status, 404, `${relay}: maintenance is not a public operator API`);
    await response.arrayBuffer();
  }
  for (const path of [`/api/overlay/${orgId}`, `/api/rundown/${orgId}/state?display=1&serviceDate=${date}`, `/api/timecode/${orgId}/state?display=1`]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 401, path);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.ok(!(await response.text()).includes("Fixture private stage message"));
  }
  await browser("open", `${origin}/timer/${orgId}`);
  await browser("wait", "text=This display needs a valid link");
  assert.equal((await browser("eval", "document.body.textContent.includes('Fixture private stage message')")).result, false);

  await browser("open", `${origin}/timer/${orgId}?displayPass=${pass("timer")}&view=stage`);
  await browser("wait", "text=Fixture private stage message");
  assert.equal((await browser("eval", "new URL(location.href).searchParams.has('displayPass')")).result, false);
  assert.equal((await browser("eval", "new URL(location.href).searchParams.get('view')")).result, "stage");
  assert.equal((await browser("eval", "document.cookie.includes('sp_display_')")).result, false, "Display cookie must be HttpOnly");
  await browser("reload");
  await browser("wait", "text=Fixture private stage message");
  await browser("open", `${origin}/timer/display-other`);
  await browser("wait", "text=This display needs a valid link");
  await browser("open", `${origin}/timer/${orgId}?displayPass=${pass("overlay")}`);
  await browser("wait", "text=This display needs a valid link");
  await browser("open", `${origin}/timer/${orgId}?displayPass=${pass("timer", orgId, true)}`);
  await browser("wait", "text=This display needs a valid link");

  const overlayResponse = await fetch(`${origin}/api/overlay/${orgId}`, { headers: { "x-showpilot-display-pass": pass("overlay") } });
  assert.equal(overlayResponse.status, 200);
  assert.equal(overlayResponse.headers.get("cache-control"), "no-store");
  assert.equal(overlayResponse.headers.get("access-control-allow-origin"), null);
  assert.equal((await overlayResponse.json())[0].title, "Fixture overlay title");
  await browser("open", `${origin}/overlay/${orgId}?displayPass=${pass("overlay")}`);
  await browser("wait", "text=Fixture overlay title");
  assert.equal((await browser("eval", "new URL(location.href).searchParams.has('displayPass')")).result, false);
  const cookieRead = await browser("eval", `(async () => { const response = await fetch('/api/overlay/${orgId}'); return { status: response.status, rows: await response.json() }; })()`);
  assert.equal(cookieRead.result.status, 200);
  assert.equal(cookieRead.result.rows[0].title, "Fixture overlay title");
  console.log(JSON.stringify({ maintenanceRoutes: "not public", anonymousReads: "denied", timerLink: "passed", privateStageMessage: "gated", httpOnlyCookieAndReload: "passed", wrongOrgAndSurface: "denied", expiredLink: "denied", overlayLink: "passed", wildcardCors: "absent" }, null, 2));
});
