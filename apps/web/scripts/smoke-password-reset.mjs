// Compiled Worker + real Better Auth/D1. Only disposable fixture credentials.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyPassword } from "better-auth/crypto";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";
const assets = resolve(import.meta.dirname, "../dist/server/assets");
let checkId;
for (const file of (await readdir(assets)).filter(file => file.endsWith(".js"))) {
  checkId ??= (await readFile(resolve(assets, file), "utf8")).match(/const checkPasswordResetLink_createServerFn_handler = createServerRpc\(\{\s*id: "([^"]+)"/)?.[1];
}
assert.ok(checkId, "Built reset-link RPC");
const firstPassword = "Fixture-new-password-85!", finalPassword = "Fixture-final-password-29!";
await withLocalSmokeFixture(async ({ origin, orgId, operatorEmail, operatorPassword, resetTokens, stopServer, queryFixture }) => {
  // A separate local HTTP client keeps intentional failed logins from charging
  // the browser user's rate bucket. Production rate limiting stays enabled.
  const post = (path, body) => fetch(`${origin}/api/auth/${path}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "cf-connecting-ip": "192.0.2.77" }, body: JSON.stringify(body) });
  await withRealBrowser({ origin }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.resetErrors=[];window.resetMode=new URL(location.href).searchParams.get('probe')??'live';window.resetChecks=0;window.resetWrites=0;
      addEventListener('error',event=>window.resetErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.resetErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        if(url.includes('/_serverFn/${checkId}')){
          window.resetChecks++;
          if(window.resetMode==='hold')return new Promise(()=>{});
          if(window.resetMode==='error')return new Response('Fixture unavailable',{status:503});
        }
        if(url.endsWith('/api/auth/reset-password')){
          window.resetWrites++;
          const response=await original(input,options);
          if(window.resetMode==='lose-save'){
            const body=await response.text();window.savedStatus=response.status;
            return new Promise(resolve=>{window.releaseSave=()=>resolve(new Response(body,{status:response.status,headers:response.headers}));});
          }
          return response;
        }
        return original(input,options);
      };` });
    const check = (expression, label, timeout) => poll(() => evaluate(expression), label, timeout);
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`, value).catch(async error => { console.log(JSON.stringify({ expected: value, page: await evaluate("document.body?.innerText"), checks: await evaluate("window.resetChecks") })); throw error; });
    const noErrors = async () => assert.deepEqual(await evaluate("window.resetErrors"), []);
    const open = path => page("Page.navigate", { url: new URL(path, origin).toString() });
    const link = (token, probe = "live") => `/reset-password?token=${token}&probe=${probe}`;
    const click = async name => {
      const point = await poll(() => evaluate(`(async()=>{
        const node=[...document.querySelectorAll('button,a')].find(node=>(node.textContent.trim()===${JSON.stringify(name)}||node.getAttribute('aria-label')===${JSON.stringify(name)})&&!node.disabled);
        if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
      })()`), `reachable ${name}`);
      await page("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await page("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const fill = (selector, value) => evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    const screenshot = async path => writeFile(path, Buffer.from((await page("Page.captureScreenshot", { format: "png" })).data, "base64"));
    const geometry = async name => {
      for (const width of [320, 768, 1440]) {
        await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await check(`(async()=>{
          const node=[...document.querySelectorAll('button,a')].find(node=>(node.textContent.trim()===${JSON.stringify(name)}||node.getAttribute('aria-label')===${JSON.stringify(name)})&&!node.disabled);
          if(!node)return false;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          const r=node.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&r.width>=44&&r.height>=44&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        })()`, `${name} at ${width}`);
        if (width === 320) await screenshot(`/tmp/showpilot-reset-${name.replaceAll(" ", "-").toLowerCase()}-320.png`);
      }
    };
    await open("/reset-password"); await text("Reset link unavailable");
    assert.equal(await evaluate("window.resetChecks"), 0); await noErrors();
    await open(link(resetTokens.expired)); await text("Reset link unavailable");
    assert.equal(await evaluate("!!document.querySelector('#password')"), false); await noErrors();
    const expired = await post("reset-password", { token: resetTokens.expired, newPassword: firstPassword });
    assert.equal(expired.status, 400); assert.equal((await expired.json()).code, "INVALID_TOKEN");
    await open(link(resetTokens.valid, "hold")); await text("Checking reset link");
    assert.equal(await evaluate("!!document.querySelector('#password')"), false);
    await text("Reset link check unavailable");
    await geometry("Retry link check");
    await evaluate("window.resetMode='error'"); await click("Retry link check"); await text("Reset link check unavailable");
    await evaluate("window.resetMode='live'"); await click("Retry link check"); await text("Set your new password");
    assert.equal(await evaluate("window.resetWrites"), 0);
    await geometry("Show password"); await geometry("Reset password");
    await fill("#password", firstPassword); await fill("#confirmPassword", firstPassword); await click("Reset password");
    await text("Password reset!"); await geometry("Sign in now");
    // The old two-second redirect must not remove this explicit choice.
    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(await evaluate("location.pathname"), "/reset-password");
    assert.equal(await evaluate("window.resetWrites"), 1); await noErrors();
    assert.equal((await post("sign-in/email", { email: operatorEmail, password: operatorPassword })).status, 401);
    const reused = await post("reset-password", { token: resetTokens.valid, newPassword: operatorPassword });
    assert.equal(reused.status, 400); assert.equal((await reused.json()).code, "INVALID_TOKEN");
    await click("Sign in now"); await check("!!document.querySelector('#email')", "sign-in form");
    await fill("#email", operatorEmail); await fill("#password", firstPassword); await click("Sign in");
    await check(`location.pathname.startsWith('/${orgId}')`, "actual new-password sign-in"); await noErrors();
    // An existing session must not redirect away from reset or recovery pages.
    await open(link(resetTokens.valid)); await text("Reset link unavailable"); await click("Request a new reset link");
    await check("location.pathname==='/forgot-password'&&!!document.querySelector('#email')", "signed-in reset recovery"); await noErrors();
    await open(link(resetTokens.lost)); await text("Set your new password");
    await evaluate("window.resetMode='lose-save'");
    await fill("#password", finalPassword); await fill("#confirmPassword", finalPassword); await click("Reset password");
    await check("window.savedStatus===200", "real committed save before lost acknowledgement");
    await text("Reset not confirmed"); await geometry("Try signing in");
    assert.equal(await evaluate("window.resetWrites"), 1);
    await evaluate("window.releaseSave();true");
    await check("document.body.innerText.includes('Reset not confirmed')", "late success stays unconfirmed");
    assert.equal(await evaluate("!!document.querySelector('#password')"), false); await noErrors();
    assert.equal((await post("sign-in/email", { email: operatorEmail, password: firstPassword })).status, 401);
    assert.equal((await post("sign-in/email", { email: operatorEmail, password: finalPassword })).status, 200);
    await open(link(resetTokens.lost)); await text("Reset link unavailable"); await noErrors();
  });
  await stopServer();
  const accounts = await queryFixture("SELECT password FROM account WHERE userId='smoke-operator' AND providerId='credential'");
  assert.equal(accounts.length, 1);
  assert.equal(await verifyPassword({ hash: accounts[0].password, password: finalPassword }), true);
  assert.equal(await verifyPassword({ hash: accounts[0].password, password: operatorPassword }), false);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM verification WHERE id IN ('smoke-reset-valid','smoke-reset-lost')"))[0].count, 0);
  console.log(JSON.stringify({ passed: true, missingExpiredAndUsedLinksRejected: true, preflightTimeoutAndRetry: true, explicitSuccessChoice: true, actualNewPasswordSignIn: true, signedInResetReachable: true, lostCommittedResponseShownAsUnconfirmed: true, noAutomaticWriteRetry: true, finalD1Verified: true, responsiveWidths: [320, 768, 1440] }));
}, { passwordReset: true });
