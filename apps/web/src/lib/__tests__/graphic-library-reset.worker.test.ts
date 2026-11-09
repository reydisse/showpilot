import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { resetSavedGraphics, type GraphicResetDatabase } from "../graphic-library-reset.server";
import { resetLowerThirdLibrary } from "../lowerthirds";
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});

let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  auth.cookie = "";
  authenticated = await fixture();
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-crew-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  return { orgId, userId, actor: { userId, sessionId: session.session.id } };
}


async function template(name: string, orgId=authenticated.orgId) {
  return getPrisma().graphicTemplate.create({data:{orgId,name,title:name,subtitle:"",style:"{}"}});
}
const templates=()=>getPrisma().graphicTemplate.findMany({where:{orgId:authenticated.orgId}});
const command=()=>({orgId:authenticated.orgId,confirmName:authenticated.orgId,requestId:crypto.randomUUID()});
it("requires exact typed organization confirmation before resetting saved templates",async()=>{
  await template("Keep");
  await expect(resetLowerThirdLibrary({data:{...command(),confirmName:"Wrong"}})).rejects.toThrow();
  expect(await templates()).toHaveLength(1);
});
it("keeps templates saved after a reset when its lost response is retried",async()=>{
  await template("Before");const data=command();
  await resetLowerThirdLibrary({data});
  expect(await templates()).toEqual([]);
  const newer=await template("After");
  await resetLowerThirdLibrary({data});
  expect((await templates()).map(row=>row.id)).toEqual([newer.id]);
});

const authority=()=>({orgId:authenticated.orgId,...authenticated.actor});
async function setting(key:string,value:string,orgId=authenticated.orgId){
  await getPrisma().appSetting.upsert({where:{orgId_key:{orgId,key}},create:{orgId,key,value},update:{value}});
}
it("acknowledges concurrent duplicates once, returns the original count and rejects changed confirmation",async()=>{
  await template("One");await template("Two");const data=command();
  const results=await Promise.all([resetLowerThirdLibrary({data}),resetLowerThirdLibrary({data})]);
  expect(results).toEqual([{requestId:data.requestId,deletedCount:2},{requestId:data.requestId,deletedCount:2}]);
  await expect(resetLowerThirdLibrary({data:{...data,confirmName:"Changed"}})).rejects.toThrow("different confirmation");
});
it("scopes deletion to its organization and keeps scenes and other settings",async()=>{
  const foreign=await seedRelayMember(crypto.randomUUID());await template("Other",foreign.orgId);await template("Delete");
  await setting("graphic-scene:fixture",'{"items":[]}');await setting("display-name","Keep");await setting("active-lower-third",'{"state":"live","name":"Independent payload"}');
  await resetLowerThirdLibrary({data:command()});
  expect(await getPrisma().graphicTemplate.count({where:{orgId:foreign.orgId}})).toBe(1);
  expect(await getPrisma().appSetting.count({where:{orgId:authenticated.orgId,key:{in:["graphic-scene:fixture","display-name","active-lower-third"]}}})).toBe(3);
  await expect(resetLowerThirdLibrary({data:{...command(),orgId:foreign.orgId}})).rejects.toThrow();
});
it("refuses active or unknown output pointers before touching the library",async()=>{
  const item=await template("Live");
  for(const [key,value] of [["active-graphics",JSON.stringify([item.id])],["active-graphic",item.id],["active-graphics","broken-json"]]){
    await setting(key,value);
    await expect(resetLowerThirdLibrary({data:command()})).rejects.toThrow("Clear program graphics");
    expect(await templates()).toHaveLength(1);
    await getPrisma().appSetting.deleteMany({where:{orgId:authenticated.orgId,key}});
  }
});
it("rechecks Program at the atomic commit and can retry after it is cleared",async()=>{
  const item=await template("Live"),data=command();
  const database:GraphicResetDatabase={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
    await setting("active-graphics",JSON.stringify([item.id]));return env.DB.batch(statements);
  }};
  await expect(resetSavedGraphics({command:data,authority:authority(),database})).rejects.toThrow("Program changed");
  expect(await templates()).toHaveLength(1);
  await setting("active-graphics","[]");
  expect(await resetLowerThirdLibrary({data})).toEqual({requestId:data.requestId,deletedCount:1});
  const newer=await template("New live");await setting("active-graphics",JSON.stringify([newer.id]));
  expect((await resetLowerThirdLibrary({data})).deletedCount).toBe(1);
  expect((await templates()).map(row=>row.id)).toEqual([newer.id]);
});
it("rolls deletion and receipt back together and recovers on the original request",async()=>{
  await template("Keep until retry");const data=command();
  await env.DB.exec("CREATE TRIGGER fail_graphic_reset BEFORE DELETE ON graphic_template BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  try {await expect(resetLowerThirdLibrary({data})).rejects.toThrow();}
  finally {await env.DB.exec("DROP TRIGGER fail_graphic_reset");}
  expect(await templates()).toHaveLength(1);
  expect(await env.DB.prepare("SELECT * FROM graphic_library_reset_receipt WHERE orgId=?").bind(data.orgId).first()).toBeNull();
  expect((await resetLowerThirdLibrary({data})).deletedCount).toBe(1);
});
it("requires danger-zone access, a current session and unchanged commit-time membership",async()=>{
  await template("Keep");const data=command();
  await env.DB.prepare("UPDATE member SET role='tm' WHERE organizationId=?").bind(data.orgId).run();
  await expect(resetLowerThirdLibrary({data})).rejects.toThrow();
  await env.DB.prepare("UPDATE member SET role='owner' WHERE organizationId=?").bind(data.orgId).run();
  const database:GraphicResetDatabase={prepare:sql=>env.DB.prepare(sql),batch:async statements=>{
    await env.DB.prepare("DELETE FROM member WHERE organizationId=?").bind(data.orgId).run();return env.DB.batch(statements);
  }};
  await expect(resetSavedGraphics({command:data,authority:authority(),database})).rejects.toThrow("access, organization, or Program changed");
  expect(await templates()).toHaveLength(1);
  await env.DB.prepare("DELETE FROM session WHERE id=?").bind(authenticated.actor.sessionId).run();
  await expect(resetLowerThirdLibrary({data})).rejects.toThrow();
});
it("requires the current name for new resets but retains a confirmed request through rename",async()=>{
  const data=command();await template("Before");await resetLowerThirdLibrary({data});await template("After");
  await getPrisma().organization.update({where:{id:data.orgId},data:{name:"Renamed"}});
  expect((await resetLowerThirdLibrary({data})).deletedCount).toBe(1);
  await expect(resetLowerThirdLibrary({data:{...data,requestId:crypto.randomUUID()}})).rejects.toThrow("exact name");
  expect(await templates()).toHaveLength(1);
});
