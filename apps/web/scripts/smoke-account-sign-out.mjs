import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const cases = process.argv.includes("--baseline") ? [["menu", "error"]] : [
  ["menu", "error"], ["profile", "hold-write"], ["menu", "lost-reply"], ["profile", "hold-read"],
];
for (const [surface, fault] of cases) await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const session = async () => {
    const response = await fetch(`${origin}/api/auth/get-session?disableCookieCache=true`, { headers: { Cookie: operatorCookie } });
    assert.equal(response.status, 200);
    return response.json();
  };
  await withRealBrowser({ origin, cookie: operatorCookie }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.signoutMode='normal';window.signoutCalls=[];window.signoutHeld=[];window.signoutErrors=[];window.signoutDocument='original';
      addEventListener('error',e=>signoutErrors.push(e.message));addEventListener('unhandledrejection',e=>signoutErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=input instanceof Request?input.url:String(input),write=url.includes('/api/auth/sign-out'),read=url.includes('/api/auth/get-session');
        if(!write&&!read)return original(input,options);
        if(write){signoutCalls.push(options?.body);sessionStorage.setItem('fixture-signout-count',String(signoutCalls.length));}
        if(write&&signoutMode==='error')return new Response(JSON.stringify({code:'FIXTURE_UNAVAILABLE',message:'Fixture unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});
        if(write&&signoutMode==='hold-write')return new Promise(resolve=>signoutHeld.push(()=>resolve(new Response(JSON.stringify({success:true}),{headers:{'Content-Type':'application/json'}}))));
        const hold=(write&&signoutMode==='lost-reply')||(read&&signoutMode==='hold-read');
        const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;
        const bytes=await response.arrayBuffer();return new Promise(resolve=>signoutHeld.push(()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))));
      };` });
    const check = (expression, label, timeout=15_000) => poll(() => evaluate(expression), label, timeout).catch(async error => {
      console.error(JSON.stringify({ surface, fault, label, state: await evaluate("({url:location.pathname,text:document.body.innerText,errors:window.signoutErrors,calls:window.signoutCalls?.length})") }));
      throw error;
    });
    const button = text => `[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getBoundingClientRect().width>0)`;
    const click = async expression => {
      const point = await check(`(async()=>{const el=${expression};if(!el||el.disabled||!Object.keys(el).some(k=>k.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`, "reachable sign-out control");
      for(const type of ["mousePressed","mouseReleased"]) await page("Input.dispatchMouseEvent", {type,button:"left",clickCount:1,...point});
    };
    await page("Page.navigate", { url: `${origin}/${orgId}/show` });
    await click(`document.querySelector('button[title="Account menu"]')`);
    if(surface==="profile") await click(button("Profile and account"));
    await evaluate(`signoutMode=${JSON.stringify(fault)};true`);
    await click(button("Sign Out"));
    await click(button("Tap again to sign out"));
    await check(`!!${button("Retry sign-out")}`, "bounded, visible sign-out failure");
    assert.equal(await evaluate("location.pathname"), `/${orgId}/show`);
    assert.equal(await evaluate("!!document.querySelector('[aria-label=\"Sign-out recovery\"] time')"), true);
    if(fault==="lost-reply") assert.equal(await session(), null);
    else assert.ok(await session());
    await evaluate("signoutMode='normal';signoutHeld.splice(0).forEach(release=>release());true");
    assert.equal(await evaluate(`!!${button("Retry sign-out")}`), true, "Late completion cannot hide failure or navigate");
    const before = await evaluate("signoutCalls.length");
    for(const [width,height] of [[320,480],[768,900],[1440,900]]) {
      await page("Emulation.setDeviceMetricsOverride", {width,height,deviceScaleFactor:1,mobile:false});
      await check(`(()=>{const el=${button("Retry sign-out")};el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`, `Sign-out Retry fits ${width}`);
      if(width===320) await writeFile(`/tmp/showpilot-signout-${surface}-${fault}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    }
    if(surface==="profile") {
      await click(`document.querySelector('button[aria-label="Back to account"]')`);
      await check(`!!${button("Retry sign-out")}`, "failure survives changing account views");
    } else {
      for (const type of ["keyDown","keyUp"]) await page("Input.dispatchKeyEvent", {type,key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await check("!document.querySelector('[role=dialog]')", "account closes");
      await click(`document.querySelector('button[title="Account menu"]')`);
      await check(`!!${button("Retry sign-out")}`, "failure survives closing the menu");
    }
    assert.deepEqual(await evaluate("signoutErrors"), []);
    await click(button("Retry sign-out"));
    await check("location.pathname==='/login'&&!!document.querySelector('input[type=password]')", "confirmed sign-out reaches login");
    assert.equal(await session(), null);
    // A document navigation drops all private client caches. The new page's
    // injected fixture starts at zero, independently of the old request history.
    assert.equal(await evaluate("signoutCalls.length"), 0);
    assert.equal(await evaluate("Number(sessionStorage.getItem('fixture-signout-count'))"), fault === "lost-reply" || fault === "hold-read" ? 1 : 2, "Lost committed response recovers without repeating sign-out");
    assert.ok(before === (fault === "hold-read" ? 0 : 1));
  });
  assert.equal((await capturedEmails()).length, 0);
  console.log(JSON.stringify({passed:true,surface,fault,retainedRecovery:true,widths:[320,768,1440],capturedEmails:0}));
}, {captureEmail:true});
