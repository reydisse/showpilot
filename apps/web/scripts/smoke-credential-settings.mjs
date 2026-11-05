// Real login and credential edits against disposable local D1 and the built Worker.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { credentialSettingsAuditSql, summarizeCredentialSettings } from "./audit-credential-settings.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  const results = {};
  for (const { key, label, section } of [
    { key: "webhook-url", label: "Webhook URL", section: "api" },
    { key: "propresenter-password", label: "ProPresenter password", section: "integrations" },
  ]) {
    const url = `${origin}/${orgId}/settings?section=${section}`;
    await browser("open", url);
    if (section === "integrations") {
      await browser("wait", 'h3:text-is("ProPresenter")');
      await browser("eval", `(() => {
        const heading = [...document.querySelectorAll('h3')].find(node => node.textContent === 'ProPresenter');
        const button = [...heading.parentElement.parentElement.querySelectorAll('button')].find(node => node.textContent.trim() === 'Connect');
        button.click();
      })()`);
    }
    const group = `[role="group"][aria-label="${label} credential"]`;
    const input = `${group} input`;
    await browser("wait", input);
    await browser("eval", `(() => {
      window.__credentialReplies = [];
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        window.__credentialReplies.push(await response.clone().text());
        return response;
      };
    })()`);
    const value = `https://fixture.invalid/${randomUUID()}`;
    await browser("fill", input, value);
    await browser("click", `${group} button:text-is("Save credential")`);
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(group)})?.textContent.includes('Credential saved.') && document.querySelector(${JSON.stringify(input)})?.value === ''`);
    const [created] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='${key}'`);
    assert.ok(created.value.startsWith("spenc:v1:"), "Credential must be encrypted in D1");
    assert.ok(!created.value.includes(value), "Plaintext must not be stored");
    const audit = summarizeCredentialSettings(await queryFixture(credentialSettingsAuditSql));
    assert.equal(audit.plaintext, 0);
    assert.equal(audit.unknownFormat, 0);
    assert.ok(audit.encrypted > 0);
    const replies = (await browser("eval", "window.__credentialReplies")).result;
    assert.ok(replies.length > 0 && replies.every(reply => !reply.includes(value) && !reply.includes(created.value)), "Save replies must contain neither credential nor ciphertext");
    for (const width of [320, 768, 2560]) {
      await browser("set", "viewport", String(width), "900");
      const geometry = (await browser("eval", `(() => { const node = document.querySelector(${JSON.stringify(group)}); return { overflow: node.scrollWidth > node.clientWidth + 1, heights: [...node.querySelectorAll('button,input')].map(control => control.getBoundingClientRect().height) }; })()`)).result;
      assert.equal(geometry.overflow, false, `Credential controls overflow at ${width}px`);
      assert.ok(geometry.heights.every(height => height >= 44), "Controls must remain reachable on touch screens");
    }
    await browser("open", url);
    await browser("wait", input);
    assert.equal((await browser("eval", `document.querySelector(${JSON.stringify(input)}).value`)).result, "");
    assert.equal((await browser("eval", `document.documentElement.outerHTML.includes(${JSON.stringify(value)})`)).result, false);
    // Touching and leaving an empty replacement never clears the saved credential.
    await browser("click", input);
    await browser("press", "Tab");
    const [kept] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='${key}'`);
    assert.ok(kept.value === created.value, "Blur must preserve the saved value");
    const replacement = `https://fixture.invalid/${randomUUID()}`;
    await browser("fill", input, replacement);
    await browser("click", `${group} button:text-is("Save replacement")`);
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(input)})?.value === '' && !document.querySelector(${JSON.stringify(input)})?.disabled`);
    const [changed] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='${key}'`);
    assert.ok(changed.value.startsWith("spenc:v1:") && changed.value !== created.value);
    await browser("click", `${group} button:text-is("Clear credential")`);
    await click("Cancel");
    const [cancelled] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='${key}'`);
    assert.ok(cancelled.value === changed.value, "Cancelled removal must preserve the credential");
    await browser("click", `${group} button:text-is("Clear credential")`);
    await browser("click", '[role="dialog"] button:text-is("Clear credential")');
    await browser("wait", "--fn", `document.querySelector(${JSON.stringify(group)})?.textContent.includes('No credential saved.')`);
    const [cleared] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='${key}'`);
    assert.equal(cleared.value, "");
    results[key] = { encryptedStorage: "passed", maskedReplies: "passed", preserveAndReplace: "passed", reload: "passed", confirmedClear: "passed", responsiveWidths: [320, 768, 2560] };
  }
  // Prove the actual inbound Slack endpoint can use its encrypted signing secret.
  await browser("open", `${origin}/${orgId}/settings?section=integrations`);
  await browser("wait", 'h3:text-is("Slack")');
  await browser("eval", `(() => {
    const heading = [...document.querySelectorAll('h3')].find(node => node.textContent === 'Slack');
    [...heading.parentElement.parentElement.querySelectorAll('button')].find(node => node.textContent.trim() === 'Connect').click();
  })()`);
  const slackInput = 'input[aria-label="Slack signing secret"]';
  await browser("wait", slackInput);
  const signingSecret = randomUUID();
  await browser("fill", slackInput, signingSecret);
  await browser("click", '[role="group"][aria-label="Slack signing secret credential"] button:text-is("Save credential")');
  await browser("wait", "--fn", `document.querySelector(${JSON.stringify(slackInput)})?.value === '' && !document.querySelector(${JSON.stringify(slackInput)})?.disabled`);
  await browser("fill", 'input[placeholder="C01234ABCDE"]', "fixture-channel");
  await browser("press", "Tab");
  await browser("wait", "text=General settings save automatically");
  const [slackSetting] = await queryFixture(`SELECT value FROM app_setting WHERE orgId='${orgId}' AND key='slack-signing-secret'`);
  assert.ok(slackSetting.value.startsWith("spenc:v1:"));
  const body = JSON.stringify({ type: "url_verification", challenge: "encrypted-secret-fixture" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex");
  const request = raw => fetch(`${origin}/api/integrations/slack/events/${orgId}`, { method: "POST", headers: { "Content-Type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body: raw });
  const verified = await request(body);
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { challenge: "encrypted-secret-fixture" });
  assert.equal((await request(body.replace("encrypted-secret-fixture", "altered"))).status, 401);
  results.slack = { encryptedSigningSecret: "passed", validSignature: "passed", tamperRejected: "passed" };
  console.log(JSON.stringify(results, null, 2));
}, { paidPlan: true });
