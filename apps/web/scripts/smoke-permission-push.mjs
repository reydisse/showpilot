// Real Better Auth mutations and browser sockets against a disposable local build.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorCookie, operatorPassword }) => {
  const signIn = async () => {
    await browser("open", `${origin}/login`);
    await browser("fill", "#email", "second@display-smoke.invalid");
    await browser("fill", "#password", operatorPassword);
    await browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
    await browser("wait", "--url", `**/${orgId}/**`);
  };
  const connect = async () => browser("eval", `Promise.all(['timecode', 'rundown', 'bridge', 'lowerthirds', 'cue-sheet', 'chat'].map(kind => new Promise((resolve, reject) => {
    window.permissionSockets ??= {};
    window.permissionCloses ??= {};
    const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/' + kind + '/${orgId}/ws?showId=smoke-show');
    window.permissionSockets[kind] = socket;
    socket.onopen = () => resolve(kind);
    socket.onclose = event => { window.permissionCloses[kind] = event.code; };
    socket.onerror = () => reject(new Error(kind + ' connection failed'));
  })))`);
  const mutate = async (path, body) => {
    const response = await fetch(`${origin}/api/auth/organization/${path}`, {
      method: "POST", headers: { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: orgId, ...body }),
    });
    assert.equal(response.status, 200, `${path}: ${await response.text()}`);
  };
  const expectClosed = async kinds => {
    for (let attempt = 0; attempt < 25; attempt++) {
      if ((await browser("eval", `${JSON.stringify(kinds)}.every(kind => window.permissionCloses[kind] === 4403)`)).result) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Permission push did not close ${kinds.join(', ')}: ${JSON.stringify(await browser("eval", "window.permissionCloses"))}`);
  };
  await signIn();
  await connect();
  const signOut = await browser("eval", `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(response => response.status)`);
  assert.equal(signOut.result, 200);
  await expectClosed(['timecode','rundown','bridge','lowerthirds','cue-sheet','chat']);
  await signIn();
  await connect();
  await mutate("update-member-role", { memberId: "smoke-second-member", role: "member" });
  await expectClosed(['timecode','rundown','bridge','lowerthirds']);
  assert.equal((await browser("eval", "window.permissionSockets.chat.readyState")).result, 1, "Members retain chat access");
  assert.equal((await browser("eval", "window.permissionSockets['cue-sheet'].readyState")).result, 1, "Members retain incident notifications");
  await mutate("remove-member", { memberIdOrEmail: "smoke-second-member" });
  await expectClosed(['chat','cue-sheet']);
  console.log(JSON.stringify({ signOutClosesAllIdleReads: "passed", roleChangeClosesRevokedReads: "passed", retainedChatPermission: "passed", memberRemovalClosesIdleChat: "passed" }, null, 2));
}, { secondOperator: true });
