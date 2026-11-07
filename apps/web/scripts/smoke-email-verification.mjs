// Real local auth and verification token; no external email service or real accounts.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

await withLocalSmokeFixture(async ({ origin, operatorPassword, unverifiedOperatorLink, stopServer, queryFixture }) => {
  await withRealBrowser({ origin }, async ({ page, evaluate }) => {
    await page("Page.enable");
    await page("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
    // Better Auth captures fetch during client initialization, so install the
    // controllable transport before any application module loads.
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.verificationErrors=[];window.verificationMode='live';window.verificationRequests=[];
      addEventListener('error',event=>window.verificationErrors.push(event.message));
      addEventListener('unhandledrejection',event=>window.verificationErrors.push(String(event.reason)));
      const original=window.fetch;
      window.fetch=(input,options)=>{
        const url=input instanceof Request?input.url:String(input);
        if(url.includes('/api/auth/get-session')){
          window.verificationRequests.push(url);
          if(window.verificationMode==='error')return Promise.resolve(new Response(JSON.stringify({message:'Fixture unavailable'}),{status:503,headers:{'Content-Type':'application/json'}}));
          if(window.verificationMode==='hold')return new Promise((resolve,reject)=>{options?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
        }
        return original(input,options);
      };` });
    const check = (expression,label,timeout) => poll(() => evaluate(expression),label,timeout);
    const text = value => check(`document.body?.innerText.includes(${JSON.stringify(value)})`,value);
    const noErrors = async () => assert.deepEqual(await evaluate("window.verificationErrors"),[]);
    const open = async path => { await page("Page.navigate",{url:new URL(path,origin).toString()}); };
    const click = async name => {
      const point=await poll(()=>evaluate(`(async()=>{
        const node=[...document.querySelectorAll('button,a')].find(node=>node.textContent.trim()===${JSON.stringify(name)}&&!node.disabled);
        if(!node)return null;node.scrollIntoView({block:'center'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return node.contains(document.elementFromPoint(x,y))?{x,y}:null;
      })()`),`reachable ${name}`);
      await page("Input.dispatchMouseEvent",{type:"mousePressed",...point,button:"left",clickCount:1});
      await page("Input.dispatchMouseEvent",{type:"mouseReleased",...point,button:"left",clickCount:1});
    };
    const fill=(selector,value)=>evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)});node.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    const screenshot=async path=>writeFile(path,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
    await open("/verify-email");await text("Sign in to check verification");
    assert.equal(await evaluate("document.body.innerText.includes('Email verified')"),false);await noErrors();
    await open("/login");await check("!!document.querySelector('#email')","login form");
    await fill("#email","unverified@display-smoke.invalid");await fill("#password",operatorPassword);await click("Sign in");
    await text("Verify your email to create an organization.");await noErrors();
    await open("/verify-email");await text("Check your inbox");
    assert.equal(await evaluate("fetch('/api/auth/get-session?disableCookieCache=true').then(response=>response.json()).then(value=>value.user.emailVerified)"),false);
    assert.equal(await evaluate("[...document.querySelectorAll('a')].some(link=>link.textContent==='Continue')"),false);
    await evaluate("window.verificationMode='error'");await click("I've verified my email");
    await text("Verification status unavailable");
    await evaluate("window.verificationMode='hold'");await click("Retry verification check");
    await text("Checking email verification");await text("Verification status unavailable");
    for(const width of [320,768,1440]){
      await page("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false});
      const geometry=await check(`(()=>{
        const section=document.querySelector('section'),button=section.querySelector('button'),r=button.getBoundingClientRect();
        const reachable=button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
        return reachable?{overflow:document.documentElement.scrollWidth>innerWidth+1||section.scrollWidth>section.clientWidth+1,height:r.height,width:r.width}:null;
      })()`,`responsive Retry at ${width}`);
      assert.equal(geometry.overflow,false);assert.ok(geometry.height>=44&&geometry.width>=44);
      if(width===320)await screenshot("/tmp/showpilot-verification-error-320.png");
    }
    await evaluate("window.verificationMode='live'");await click("Retry verification check");await text("Check your inbox");
    const requests=await evaluate("window.verificationRequests");
    assert.ok(requests.filter(url=>new URL(url,origin).searchParams.get('disableCookieCache')==='true').length>=4);
    // The fixture deliberately has no email provider secret; no email can leave it.
    await click("Resend verification email");await text("We couldn't confirm that the email was sent.");await text("Retry sending verification email");
    assert.equal(await evaluate("document.body.innerText.includes('Email verified')"),false);
    await page("Emulation.setDeviceMetricsOverride",{width:320,height:900,deviceScaleFactor:1,mobile:false});
    await screenshot("/tmp/showpilot-verification-resend-320.png");await noErrors();
    await open(await unverifiedOperatorLink());await text("Email verified");
    assert.equal(await evaluate("fetch('/api/auth/get-session?disableCookieCache=true').then(response=>response.json()).then(value=>value.user.emailVerified)"),true);
    await click("Continue");await check("!!document.querySelector('#organization-name')","verified setup");
    assert.equal(await evaluate("document.body.innerText.includes('Verify your email to create an organization.')"),false);
    await noErrors();
  });
  await stopServer();
  const users=await queryFixture("SELECT id,emailVerified FROM user WHERE id IN ('smoke-unverified','smoke-operator') ORDER BY id");
  assert.deepEqual(users,[{id:"smoke-operator",emailVerified:1},{id:"smoke-unverified",emailVerified:1}]);
  assert.equal((await queryFixture("SELECT COUNT(*) AS count FROM member WHERE userId='smoke-unverified'"))[0].count,0);
  console.log(JSON.stringify({passed:true,anonymousAndUnverifiedStayUnconfirmed:true,actualVerificationToken:true,freshSessionRead:true,failedAndTimedOutCheckRecovery:true,rejectedResendVisible:true,setupAgrees:true,responsiveWidths:[320,768,1440],screenshots:["/tmp/showpilot-verification-error-320.png","/tmp/showpilot-verification-resend-320.png"]}));
},{unverifiedOperator:true});
