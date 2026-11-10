import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getOutputStatuses } from "../stream-destinations";

const auth = vi.hoisted(() => ({ userId: "" }));
vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: auth.userId, name: "Fixture", email: "fixture@example.test" } }) } }) }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (data: unknown) => data;
    const chain = { middleware: () => chain, inputValidator: (fn: typeof validate) => { validate = fn; return chain; }, handler: (fn: (input: { data: unknown }) => unknown) => (input: { data: unknown }) => fn({ data: validate(input.data) }), server: () => chain };
    return chain;
  };
  return { createServerFn: builder, createMiddleware: builder, createServerOnlyFn: <T>(fn: T): T => fn };
});
const originalAccount = env.CLOUDFLARE_ACCOUNT_ID;
const originalToken = env.CLOUDFLARE_STREAM_API_TOKEN;
afterEach(() => { vi.restoreAllMocks(); env.CLOUDFLARE_ACCOUNT_ID = originalAccount; env.CLOUDFLARE_STREAM_API_TOKEN = originalToken; });
async function fixture() {
  const member = await seedRelayMember(`outputs-${crypto.randomUUID()}`);
  auth.userId = member.userId;
  env.CLOUDFLARE_ACCOUNT_ID = "fixture-account";
  env.CLOUDFLARE_STREAM_API_TOKEN = "fixture-token";
  const inputId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Fixture ingest','fixture-input')").bind(inputId, member.orgId).run();
  const add = async (output: string, input = inputId) => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO stream_destination(id,orgId,name,platform,streamKey,enabled,cfOutputId,liveInputId) VALUES(?,?,'Fixture','custom','fixture-private-key',1,?,?)").bind(id,member.orgId,output,input).run();
    return id;
  };
  return { ...member, inputId, add };
}

it("reads each input once and returns only enabled/disabled/missing states without credentials", async () => {
  const f = await fixture();
  const enabled = await f.add("one"), disabled = await f.add("two"), missing = await f.add("gone");
  const fetch = vi.spyOn(globalThis,"fetch").mockResolvedValue(Response.json({ success: true, result: [
    { uid: "one", enabled: true, streamKey: "provider-private-key", status: "connected" },
    { uid: "two", enabled: false },
  ] }));
  const result = await getOutputStatuses({ data: { orgId: f.orgId } });
  expect(result).toEqual({ [enabled]: { status: "enabled" }, [disabled]: { status: "disabled" }, [missing]: { status: "missing" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toMatch(/private-key|connected/);
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it("marks pending operations unconfirmed and refuses a foreign live-input reference", async () => {
  const f = await fixture();
  const other = await seedRelayMember(`other-outputs-${crypto.randomUUID()}`);
  const foreignInput = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Other ingest','foreign-input')").bind(foreignInput,other.orgId).run();
  const pending = await f.add(`pending:${Date.now()}:fixture`);
  const foreign = await f.add("other-output",foreignInput);
  const fetch = vi.spyOn(globalThis,"fetch");
  const result = await getOutputStatuses({ data: { orgId: f.orgId } });
  expect(result[pending]).toEqual({ status: "unconfirmed" });
  expect(result[foreign]).toMatchObject({ status: "unknown" });
  expect(fetch).not.toHaveBeenCalled();
  await expect(getOutputStatuses({ data: { orgId: other.orgId } })).rejects.toThrow("Forbidden");
  await env.DB.prepare("DELETE FROM member WHERE organizationId=? AND userId=?").bind(f.orgId,f.userId).run();
  await expect(getOutputStatuses({ data: { orgId: f.orgId } })).rejects.toThrow("Forbidden");
});

it("bounds a stalled response body while retaining an independent input result", async () => {
  const f = await fixture();
  const slow = await f.add("slow");
  const fastInput = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO live_input(id,orgId,name,cfInputId) VALUES(?,?,'Fast ingest','fast-input')").bind(fastInput,f.orgId).run();
  const fast = await f.add("fast",fastInput);
  let close = () => {};
  const fetch = vi.spyOn(globalThis,"fetch").mockImplementation(async input => String(input).includes("fast-input")
    ? Response.json({ result: [{ uid: "fast",enabled: true }] })
    : new Response(new ReadableStream({ start(controller) { close = () => controller.close(); } })));
  try {
    const started = Date.now();
    const result = await getOutputStatuses({ data: { orgId: f.orgId } });
    expect(Date.now()-started).toBeLessThan(8_000);
    expect(result[slow]).toMatchObject({ status: "unknown", error: expect.stringContaining("Retry") });
    expect(result[fast]).toEqual({ status: "enabled" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([,options]) => options?.signal?.aborted)).toBe(true);
  } finally { close(); }
}, 10_000);

it("treats provider failures, malformed data and omitted enabled flags as unknown without changing stored output IDs", async () => {
  const f = await fixture(); const id = await f.add("one");
  vi.spyOn(globalThis,"fetch")
    .mockResolvedValueOnce(new Response("private-provider-error",{ status: 503 }))
    .mockResolvedValueOnce(Response.json({ result: "invalid" }))
    .mockResolvedValueOnce(Response.json({ result: [{ uid: "one" }] }));
  for (let i=0;i<3;i++) {
    const result = await getOutputStatuses({ data: { orgId: f.orgId } });
    expect(result[id]).toMatchObject({ status: "unknown" });
    expect(JSON.stringify(result)).not.toContain("private-provider-error");
  }
  expect(await env.DB.prepare("SELECT cfOutputId FROM stream_destination WHERE id=? AND orgId=?").bind(id,f.orgId).first("cfOutputId")).toBe("one");
});
