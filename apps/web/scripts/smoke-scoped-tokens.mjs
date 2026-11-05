// Real creation, storage, authentication, one-time display and revocation on disposable local data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, orgId, browser, operatorEmail, operatorPassword, queryFixture }) => {
  const click = name => browser("find", "role", "button", "click", "--name", name, "--exact");
  await browser("open", `${origin}/login`);
  await browser("fill", "#email", operatorEmail);
  await browser("fill", "#password", operatorPassword);
  await click("Sign in");
  await browser("wait", "--url", `**/${orgId}/**`);
  const results = {};
  for (const kind of ["kiosk", "companion"]) {
    const path = kind === "kiosk" ? "/api/v1/kiosk/org" : "/api/v1/companion/state";
    const settingsUrl = `${origin}/${orgId}/settings?section=${kind}`;
    await browser("open", settingsUrl);
    if (kind === "kiosk") await click("Access Tokens");
    await browser("wait", 'input[aria-label="Token label"]');
    await browser("eval", `(() => {
      window.__tokenGets = [];
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
        if (method === 'GET') window.__tokenGets.push(await response.clone().text());
        return response;
      };
    })()`);
    const label = `${kind} fixture access`;
    await browser("fill", 'input[aria-label="Token label"]', label);
    await click("Generate");
    await browser("wait", 'textarea[aria-label="New token"]');
    const token = (await browser("eval", 'document.querySelector(\'textarea[aria-label="New token"]\').value')).result;
    assert.equal(typeof token, "string");
    const payload = JSON.parse(Buffer.from(token.replace(/^cmp_/, "").split(".")[1], "base64url").toString());
    assert.equal(typeof payload.jti, "string", "Creation must issue a distinct token identity");
    const hash = `sha256:${createHash("sha256").update(token).digest("hex")}`;
    const [stored] = await queryFixture(`SELECT id, token, revokedAt FROM ${kind}_token WHERE orgId = '${orgId}'`);
    assert.ok(stored.token === hash, "D1 must store only the digest");
    assert.equal(stored.revokedAt, null);
    const api = presented => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${presented}` }, cache: "no-store" });
    assert.equal((await api(token)).status, 200, "New token must authenticate");
    assert.equal((await api(hash)).status, 401, "A stored digest must not authenticate");
    await browser("wait", `text=Token saved. Its value cannot be shown again.`);
    const reads = (await browser("eval", "window.__tokenGets")).result;
    assert.ok(reads.some(text => text.includes(label)), "Observe the actual metadata list response");
    assert.ok(reads.every(text => !text.includes(token) && !text.includes(hash)), "List responses must contain neither token nor digest");
    for (const width of [320, 768, 2560]) {
      await browser("set", "viewport", String(width), "900");
      const geometry = (await browser("eval", `(() => {
        const notice = document.querySelector('[aria-label="New access token"]');
        return { overflow: notice.scrollWidth > notice.clientWidth + 1, buttons: [...notice.querySelectorAll('button')].map(button => button.getBoundingClientRect().height) };
      })()`)).result;
      assert.equal(geometry.overflow, false, `Token notice overflows at ${width}px`);
      assert.ok(geometry.buttons.every(height => height >= 44));
    }
    await click("Dismiss token");
    assert.equal((await browser("eval", `document.documentElement.outerHTML.includes(${JSON.stringify(token)})`)).result, false);
    await browser("open", settingsUrl);
    if (kind === "kiosk") await click("Access Tokens");
    await browser("wait", "text=Token saved. Its value cannot be shown again.");
    assert.equal((await browser("eval", `document.documentElement.outerHTML.includes(${JSON.stringify(token)})`)).result, false);
    assert.equal((await browser("eval", "[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Reveal')")).result, false);
    await browser("click", 'button[title="Revoke token"]');
    await click("Cancel");
    assert.equal((await api(token)).status, 200, "Cancelled revocation must preserve access");
    await browser("click", 'button[title="Revoke token"]');
    await browser("wait", '[role="dialog"]');
    await browser("eval", "[...document.querySelector('[role=dialog]').querySelectorAll('button')].find(button => button.textContent.trim() === 'Revoke token').click()");
    await browser("wait", "text=No tokens yet");
    assert.equal((await api(token)).status, 401, "Revoked token must stop authenticating");
    results[kind] = { hashStorage: "passed", authentication: "passed", metadataOnlyReads: "passed", oneTimeDisplay: "passed", responsiveWidths: [320, 768, 2560], confirmedRevocation: "passed" };
  }
  console.log(JSON.stringify(results, null, 2));
}, { paidPlan: true });
