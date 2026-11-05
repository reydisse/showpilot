// Real built Worker, browser chat controls, disposable local D1 and guest passes.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, crewChatPass, operatorCookie, operatorEmail, operatorPassword, revokeFixtureOperator }) => {
  const headers = { Cookie: operatorCookie, Origin: origin, "Content-Type": "application/json" };
  const history = async () => {
    const response = await fetch(`${origin}/api/chat/${orgId}/history`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).messages;
  };
  await browser("open", `${origin}/join/chat/${crewChatPass()}`);
  await browser("fill", "input", "Guest fixture");
  await browser("find", "role", "button", "click", "--name", "Join Team Chat", "--exact");
  await browser("wait", "textarea");
  await browser("fill", "textarea", "Guest message through verified pass");
  await browser("press", "Enter");
  await browser("wait", "text=Guest message through verified pass");
  // The UI can show an optimistic bubble; persisted history proves acceptance.
  let messages = [];
  for (let attempt = 0; attempt < 25; attempt++) {
    messages = await history();
    if (messages.some(message => message.text === "Guest message through verified pass")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const guest = messages.find(message => message.text === "Guest message through verified pass");
  assert.equal(guest?.senderName, "Guest fixture");
  assert.equal(guest?.senderRole, "Guest");
  assert.equal(guest?.senderId, undefined);

  const sent = await fetch(`${origin}/api/chat/${orgId}/send?authUserId=forged&role=owner`, {
    method: "POST", headers, body: JSON.stringify({ text: "Member HTTP message", senderId: "forged", senderName: "Forged" }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).message.senderId, "smoke-operator");
  await browser("wait", "text=Member HTTP message");

  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await browser("find", "role", "button", "click", "--name", "Sign in", "--exact");
  await browser("wait", "--url", `**/${orgId}/**`);
  await browser("open", `${origin}/${orgId}/chat`);
  await browser("wait", "text=Member HTTP message");
  await browser("fill", "textarea", "Member browser message");
  await browser("press", "Enter");
  for (let attempt = 0; attempt < 25; attempt++) {
    messages = await history();
    if (messages.some(message => message.text === "Member browser message")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(messages.find(message => message.text === "Member browser message")?.senderId, "smoke-operator");
  await browser("eval", `new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/chat/${orgId}/ws');
    window.authoritySmokeSocket = ws;
    ws.onmessage = event => { if (JSON.parse(event.data).type === 'hydrate') resolve(true); };
    ws.onerror = () => reject(new Error('Chat socket failed'));
  })`);
  await revokeFixtureOperator();
  const revoked = await browser("eval", `new Promise((resolve, reject) => {
    const ws = window.authoritySmokeSocket;
    const timeout = setTimeout(() => reject(new Error('Revoked socket remained writable')), 10000);
    ws.onclose = event => { clearTimeout(timeout); resolve(event.code); };
    ws.send(JSON.stringify({ type: 'message', text: 'Must be rejected' }));
  })`);
  assert.equal(revoked.result, 4403);
  await browser("open", `${origin}/join/chat/${crewChatPass(-1)}`);
  await browser("wait", "text=This crew pass has expired");
  console.log(JSON.stringify({ guestSendAndReceive: "passed", memberHttpIdentity: "passed", memberBrowserSend: "passed", revokedOpenSocket: "denied", expiredGuestPass: "denied" }, null, 2));
});
