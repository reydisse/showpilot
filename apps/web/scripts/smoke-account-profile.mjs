import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
import { poll, withRealBrowser } from "./real-browser-fixture.mjs";

const directory = await mkdtemp(join(tmpdir(), "showpilot-profile-images-"));
try {
await withLocalSmokeFixture(async ({ origin, orgId, operatorCookie, capturedEmails }) => {
  const headers = { Cookie: operatorCookie, Origin: origin };
  async function current() {
    const response = await fetch(`${origin}/api/user/profile`, {headers});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    return response.json();
  }
  const initial = await current();
  assert.equal(initial.revision, 1, "Migration backfills the existing account");
  assert.equal(initial.name, "Fixture operator");
  assert.equal(initial.image, null);
  async function saveName(name, expectedRevision) {
    const response = await fetch(`${origin}/api/user/profile`, {method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({userId:initial.userId,requestId:crypto.randomUUID(),kind:"name",name,expectedRevision})});
    assert.equal(response.status,200); return response.json();
  }
  async function savePhoto(bytes, expectedRevision) {
    const form = new FormData();form.set("userId",initial.userId);form.set("requestId",crypto.randomUUID());form.set("expectedRevision",String(expectedRevision));form.set("file",new File([bytes],"blue.jpg",{type:"image/jpeg"}));
    const response=await fetch(`${origin}/api/user/profile/photo`,{method:"POST",headers,body:form});
    assert.equal(response.status,200);return response.json();
  }
  await withRealBrowser({origin,cookie:operatorCookie},async({page,evaluate})=>{
    await page("Page.enable");await page("DOM.enable");
    await page("Emulation.setFocusEmulationEnabled",{enabled:true});
    await page("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await page("Page.addScriptToEvaluateOnNewDocument",{source:`
      window.profileMode={read:'hold',name:'hold',photo:'hold',reset:'hold'};
      window.profileCalls={name:[],photo:[],reset:0};window.profileHeld=[];window.profileErrors=[];window.profileDocument='same';
      window.profilePhotoUrls=new Set();window.profilePhotoUrlCount=0;
      const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
      URL.createObjectURL=blob=>{const url=create(blob);profilePhotoUrls.add(url);profilePhotoUrlCount++;return url;};
      URL.revokeObjectURL=url=>{profilePhotoUrls.delete(url);return revoke(url);};
      addEventListener('error',e=>profileErrors.push(e.message));addEventListener('unhandledrejection',e=>profileErrors.push(String(e.reason)));
      const original=fetch;window.fetch=async(input,options)=>{
        const url=new URL(input instanceof Request?input.url:String(input),location.href),method=options?.method||'GET';
        const kind=url.pathname==='/api/user/profile'?(method==='POST'?'name':'read'):url.pathname==='/api/user/profile/photo'?'photo':url.pathname==='/api/auth/request-password-reset'?'reset':null;
        if(!kind)return original(input,options);
        if(kind==='name')profileCalls.name.push(JSON.parse(options.body));
        if(kind==='reset')profileCalls.reset++;
        if(kind==='photo'){const form=options.body,bytes=await form.get('file').arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');profileCalls.photo.push({requestId:form.get('requestId'),revision:Number(form.get('expectedRevision')),hash});}
        const hold=profileMode[kind]==='hold';
        const response=await original(input,hold?{...options,signal:new AbortController().signal}:options);
        if(!hold)return response;
        const bytes=await response.arrayBuffer();return new Promise(resolve=>profileHeld.push({kind,release:()=>resolve(new Response(bytes,{status:response.status,headers:response.headers}))}));
      };`});
    const check=(expression,label,timeout=15_000)=>poll(()=>evaluate(expression),label,timeout).catch(async error=>{
      console.error(JSON.stringify({label,state:await evaluate("({text:document.body.innerText,errors:window.profileErrors,calls:window.profileCalls})")}));throw error;
    });
    const button=text=>`[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(text)}&&el.getBoundingClientRect().width>0)`;
    const click=async expression=>{
      const point=await check(`(async()=>{const el=${expression};if(!el||el.disabled||!Object.keys(el).some(k=>k.startsWith('__reactProps')))return null;el.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`,"reachable profile control");
      for(const type of ["mousePressed","mouseReleased"])await page("Input.dispatchMouseEvent",{type,button:"left",clickCount:1,...point});
    };
    const release=kind=>evaluate(`profileMode[${JSON.stringify(kind)}]='normal';profileHeld.filter(x=>x.kind===${JSON.stringify(kind)}).forEach(x=>x.release());profileHeld=profileHeld.filter(x=>x.kind!==${JSON.stringify(kind)});true`);
    const draft=async name=>{
      await evaluate(`(()=>{const el=document.querySelector('#profile-display-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(name)});el.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      await check(`document.querySelector('#profile-display-name')?.value===${JSON.stringify(name)}`,"profile draft entered");
    };
    const sizes=async(label,screenshot)=>{
      for(const [width,height] of [[320,480],[768,1000],[1440,1000]]){
        await page("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
        await check(`(()=>{const el=${button(label)};if(!el)return false;el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();return b.width>=44&&b.height>=44&&b.left>=0&&b.right<=innerWidth&&el.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));})()`,`${label} fits ${width}`);
        if(width===320)await writeFile(`/tmp/showpilot-profile-${screenshot}-320.png`,Buffer.from((await page("Page.captureScreenshot",{format:"png"})).data,"base64"));
      }
    };
    await page("Page.navigate",{url:`${origin}/${orgId}/show`});
    await click(`document.querySelector('button[title="Account menu"]')`);
    await click(button("Profile and account"));
    await check(`!!${button("Retry profile check")}`,"initial profile read deadline");
    await draft("Retained draft");
    assert.equal(await evaluate(`!!${button("Save changes")}?.disabled`),true);
    await sizes("Retry profile check","read-failure");
    await release("read");
    assert.equal(await evaluate(`!!${button("Retry profile check")}`),true);
    await click(button("Retry profile check"));
    await check(`!${button("Save changes")}.disabled`,"initial read recovered without losing draft");
    await draft("   ");
    await check(`document.querySelector('#profile-name-status')?.textContent==='Enter a display name.'&&${button("Save changes")}.disabled&&!document.querySelector('footer')?.innerText.includes('Saved')`,"empty draft is not claimed saved");
    await draft("Retained draft");
    await click(button("Reset password"));
    await click(button("Save changes"));
    await check("profileCalls.name.length===1&&profileHeld.some(x=>x.kind==='name')","name committed with response held");
    const firstName=(await evaluate("profileCalls.name"))[0];
    assert.equal(firstName.expectedRevision,1);
    assert.equal((await current()).name,"Retained draft");
    await saveName("Newer operator",2);
    await click(`document.querySelector('button[aria-label="Back to account"]')`);
    await click(button("Profile and account"));
    await check(`!!${button("Retry profile save")}`,"name deadline survives reopening");
    assert.equal(await evaluate("document.querySelector('#profile-display-name').value"),"Retained draft");
    await sizes("Retry profile save","save-failure");
    await release("name");
    assert.equal(await evaluate(`!!${button("Retry profile save")}`),true);
    await click(button("Retry profile save"));
    await check("document.body.innerText.includes('The newer profile was kept')","old name retry keeps newer profile");
    await check("document.querySelector('#profile-name-status')?.textContent==='Saved name: Newer operator'","conflict shows saved name for comparison");
    assert.deepEqual((await evaluate("profileCalls.name"))[1],firstName);
    assert.equal((await current()).name,"Newer operator");
    await click(button("Save changes"));
    await check("profileCalls.name.length===3&&[...document.querySelectorAll('footer span')].some(el=>el.textContent.trim()==='Saved'&&el.getBoundingClientRect().width>0)","explicit fresh name acknowledged");
    const freshName=(await evaluate("profileCalls.name"))[2];
    assert.equal(freshName.expectedRevision,3);assert.notEqual(freshName.requestId,firstName.requestId);
    assert.equal((await current()).name,"Retained draft");

    const samples=await evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');ctx.fillStyle='#ef4444';ctx.fillRect(0,0,256,256);const red=c.toDataURL('image/png');ctx.fillStyle='#2563eb';ctx.fillRect(0,0,256,256);return {red,blue:c.toDataURL('image/jpeg',0.85)};})()`);
    const redPath=join(directory,"red.png");await writeFile(redPath,Buffer.from(samples.red.split(",")[1],"base64"));
    const root=await page("DOM.getDocument"),input=await page("DOM.querySelector",{nodeId:root.root.nodeId,selector:'[role="dialog"] input[type="file"]'});
    await page("DOM.setFileInputFiles",{nodeId:input.nodeId,files:[redPath]});
    await check("profileCalls.photo.length===1&&profileHeld.some(x=>x.kind==='photo')","real canvas photo committed with lost reply");
    const firstPhoto=(await evaluate("profileCalls.photo"))[0];
    assert.equal(firstPhoto.revision,4);
    const redState=await current();assert.match(redState.image,new RegExp(firstPhoto.hash+"\\.jpg$"));
    const redResponse=await fetch(origin+redState.image);assert.equal(redResponse.status,200);const redBytes=Buffer.from(await redResponse.arrayBuffer());
    const blue=await savePhoto(Buffer.from(samples.blue.split(",")[1],"base64"),5);
    assert.equal(blue.outcome,"applied");
    await check(`!!${button("Retry profile save")}`,"photo save deadline");
    await release("photo");await click(button("Retry profile save"));
    await check(`!!${button("Use selected photo")}`,"conflicted photo remains available");
    assert.deepEqual((await evaluate("profileCalls.photo"))[1],firstPhoto);
    assert.equal((await current()).image,blue.state.image);
    assert.deepEqual(Buffer.from(await(await fetch(origin+redState.image)).arrayBuffer()),redBytes,"Previously published photo bytes remain immutable");
    await check(`document.querySelector('button[aria-label="Change profile photo"] img')?.getAttribute('src')===${JSON.stringify(blue.state.image)}`,"newer photo displayed");
    await evaluate("profileMode.read='hold';true");
    await click(button("Use selected photo"));
    await check(`!!${button("Retry profile check")}`,"failed refresh after acknowledged photo");
    assert.equal(await evaluate(`!!${button("Retry profile save")}`),false);
    const appliedPhoto=(await evaluate("profileCalls.photo"))[2];
    assert.notEqual(appliedPhoto.requestId,firstPhoto.requestId);assert.equal(appliedPhoto.revision,6);assert.equal(appliedPhoto.hash,firstPhoto.hash);
    assert.equal(await evaluate("profilePhotoUrlCount"),1,"Retry reuses prepared photo bytes");
    assert.equal(await evaluate("profilePhotoUrls.size"),0,"Image preparation releases its object URL");
    await release("read");await click(button("Retry profile check"));
    await check("!document.querySelector('[role=dialog]').innerText.includes('Saved profile could not be checked')","photo refresh recovered");
    assert.equal((await current()).image,redState.image);assert.equal((await current()).revision,7);
    assert.equal(await evaluate("profileCalls.photo.length"),3);
    await sizes("Choose photo","recovered");

    await check(`!!${button("Retry reset email")}`,"reset email remains uncertain after timeout");
    assert.equal((await capturedEmails()).length,1);
    await release("reset");
    assert.equal(await evaluate(`!!${button("Retry reset email")}`),true,"Late reset acknowledgement cannot claim success");
    await check(`!${button("Retry reset email")}?.disabled`,"reset retry cooldown expires",70_000);
    await click(button("Retry reset email"));
    await check(`!!${button("Reset link requested")}`,"explicit reset resend confirmed");
    assert.equal((await capturedEmails()).length,2);
    assert.equal(await evaluate("profileCalls.reset"),2);
    assert.equal(await evaluate("profileDocument"),"same");
    assert.deepEqual(await evaluate("profileErrors"),[]);
  });
  console.log(JSON.stringify({passed:true,migrationBackfill:true,realImagePreparation:true,immutablePhotos:true,exactRetries:true,newerProfilePreserved:true,selectedPhotoPreserved:true,resetEmailRecovery:true,capturedEmails:2,widths:[320,768,1440]}));
},{captureEmail:true,accountProfileRecovery:true});
} finally { await rm(directory,{recursive:true,force:true}); }
