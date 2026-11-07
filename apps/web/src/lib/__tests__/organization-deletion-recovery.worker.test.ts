import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import { deleteOrganization } from "../org-deletion";
const provider=vi.hoisted(()=>({cancel:vi.fn()}));
vi.mock("../stripe.server",()=>({getStripe:()=>({subscriptions:{cancel:provider.cancel}}),isMissingStripeResource:()=>false}));
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
  provider.cancel.mockReset();
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


afterEach(async()=>{await abortAllDurableObjects();});
it("deletes a disposable organization through the real authenticated workflow",async()=>{
  const {orgId}=authenticated;
  await env.STORAGE.put(`orgs/${orgId}/fixture.txt`,"fixture upload");
  const result=await deleteOrganization({data:{orgId,confirmName:orgId}});
  expect(result).toEqual({alreadyDeleted:false});
  expect(await getPrisma().organization.findUnique({where:{id:orgId}})).toBeNull();
  expect(await env.STORAGE.head(`orgs/${orgId}/fixture.txt`)).toBeNull();
});

it("can recover confirmation when the successful deletion response is lost",async()=>{
  const {orgId}=authenticated,data={orgId,confirmName:orgId};
  await deleteOrganization({data});
  await expect(deleteOrganization({data})).resolves.toEqual({alreadyDeleted:true});
});
it("can retry after the final organization delete fails without losing its owner",async()=>{
  const {orgId,userId}=authenticated,data={orgId,confirmName:orgId};
  await env.DB.exec("CREATE TRIGGER fail_org_final_delete BEFORE DELETE ON organization BEGIN SELECT RAISE(ABORT,'fixture final delete failure'); END;");
  try {await expect(deleteOrganization({data})).rejects.toThrow();}
  finally {await env.DB.exec("DROP TRIGGER fail_org_final_delete");}
  expect(await getPrisma().organization.findUnique({where:{id:orgId}})).not.toBeNull();
  expect(await getPrisma().member.findFirst({where:{organizationId:orgId,userId}})).not.toBeNull();
  await expect(deleteOrganization({data})).resolves.toEqual({alreadyDeleted:false});
});

it("keeps other organizations and the user's account/session while deleting all target rows",async()=>{
  const {orgId,userId,actor}=authenticated;
  const other=await seedRelayMember(crypto.randomUUID());
  await getPrisma().member.create({data:{id:crypto.randomUUID(),organizationId:other.orgId,userId,role:"owner",createdAt:new Date()}});
  await getPrisma().graphicTemplate.create({data:{orgId,name:"Delete",title:"Delete",style:"{}"}});
  await getPrisma().graphicTemplate.create({data:{orgId:other.orgId,name:"Keep",title:"Keep",style:"{}"}});
  await env.DB.prepare("INSERT INTO graphic_library_reset_receipt(orgId,actorId,requestId,confirmName,claimId,deletedCount) VALUES(?,?,?,?,?,0)").bind(orgId,userId,crypto.randomUUID(),orgId,"fixture").run();
  await deleteOrganization({data:{orgId,confirmName:orgId}});
  expect(await getPrisma().user.findUnique({where:{id:userId}})).not.toBeNull();
  expect(await getPrisma().session.findUnique({where:{id:actor.sessionId}})).not.toBeNull();
  expect(await getPrisma().member.count({where:{organizationId:other.orgId}})).toBe(2);
  expect(await getPrisma().graphicTemplate.count({where:{orgId:other.orgId}})).toBe(1);
  expect(await getPrisma().graphicTemplate.count({where:{orgId}})).toBe(0);
  expect(await env.DB.prepare("SELECT * FROM graphic_library_reset_receipt WHERE orgId=?").bind(orgId).first()).toBeNull();
});
it("rejects wrong names, other organizations, non-owners and revoked or stale sessions before cleanup",async()=>{
  const {orgId,actor}=authenticated,data={orgId,confirmName:orgId};
  const other=await seedRelayMember(crypto.randomUUID());
  await expect(deleteOrganization({data:{...data,orgId:other.orgId,confirmName:other.orgId}})).rejects.toThrow("owner");
  await expect(deleteOrganization({data:{...data,confirmName:"Wrong"}})).rejects.toThrow("does not match");
  await env.DB.prepare("UPDATE member SET role='admin' WHERE organizationId=?").bind(orgId).run();
  await expect(deleteOrganization({data})).rejects.toThrow("owner");
  await env.DB.prepare("UPDATE member SET role='owner' WHERE organizationId=?").bind(orgId).run();
  await getPrisma().session.update({where:{id:actor.sessionId},data:{createdAt:new Date(Date.now()-31*60_000)}});
  await expect(deleteOrganization({data})).rejects.toThrow("recent sign-in");
  await getPrisma().session.delete({where:{id:actor.sessionId}});
  await expect(deleteOrganization({data})).rejects.toThrow("Unauthorized");
  expect(await getPrisma().organization.findUnique({where:{id:orgId}})).not.toBeNull();
  expect(await getPrisma().appSetting.findUnique({where:{orgId_key:{orgId,key:"organization-deleting"}}})).toBeNull();
});
it("leaves data intact on subscription cancellation failure and resumes on retry",async()=>{
  const {orgId}=authenticated,data={orgId,confirmName:orgId};
  await getPrisma().organization.update({where:{id:orgId},data:{stripeSubscriptionId:"sub_fixture_deletion"}});
  await env.STORAGE.put(`orgs/${orgId}/keep.txt`,"fixture");
  provider.cancel.mockRejectedValueOnce(new Error("Fixture billing unavailable"));
  await expect(deleteOrganization({data})).rejects.toThrow("billing unavailable");
  expect(await getPrisma().member.count({where:{organizationId:orgId}})).toBe(1);
  expect(await env.STORAGE.head(`orgs/${orgId}/keep.txt`)).not.toBeNull();
  expect(await getPrisma().appSetting.findUnique({where:{orgId_key:{orgId,key:"organization-deleting"}}})).toBeNull();
  provider.cancel.mockResolvedValueOnce({id:"sub_fixture_deletion",status:"canceled"});
  await expect(deleteOrganization({data})).resolves.toEqual({alreadyDeleted:false});
  expect(provider.cancel).toHaveBeenCalledTimes(2);
});
it("retains the deletion marker and owner when child data cleanup fails, then resumes",async()=>{
  const {orgId,userId}=authenticated,data={orgId,confirmName:orgId};
  await getPrisma().graphicTemplate.create({data:{orgId,name:"Delete",title:"Delete",style:"{}"}});
  await env.DB.exec("CREATE TRIGGER fail_org_graphic_delete BEFORE DELETE ON graphic_template BEGIN SELECT RAISE(ABORT,'fixture child delete failure'); END;");
  try {await expect(deleteOrganization({data})).rejects.toThrow();}
  finally {await env.DB.exec("DROP TRIGGER fail_org_graphic_delete");}
  expect(await getPrisma().member.findFirst({where:{organizationId:orgId,userId}})).not.toBeNull();
  expect(await getPrisma().appSetting.findUnique({where:{orgId_key:{orgId,key:"organization-deleting"}}})).not.toBeNull();
  await expect(deleteOrganization({data})).resolves.toEqual({alreadyDeleted:false});
});
