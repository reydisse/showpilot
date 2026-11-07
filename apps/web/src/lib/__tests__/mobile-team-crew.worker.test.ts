import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";

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
beforeEach(() => {
  auth.cookie = "";
  vi.restoreAllMocks();
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
  const input = {
    orgId,
    memberId: "CAM42",
    name: "Casey Crew",
    role: "Camera",
    email: "casey@example.test",
    photoUrl: "",
    requestId: crypto.randomUUID(),
  };
  const row = () =>
    getPrisma().crewMember.findFirstOrThrow({
      where: { orgId, memberId: "CAM42" },
    });
  return { orgId, userId, input, row };
}

import { handleMobileApi } from "../mobile-api.server";
async function mobileRequest(orgId: string, path = "", body?: unknown) {
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/team/crew${path}?orgId=${orgId}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: auth.cookie, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Missing native crew route");
  return response;
}
it("lists the organization-scoped roster and serializes check-in state", async () => {
  const f = await fixture();
  await getPrisma().crewMember.create({
    data: {
      orgId: f.orgId,
      memberId: "CAM42",
      name: "Ada Operator",
      role: "Camera",
      isOnline: true,
    },
  });
  const response = await mobileRequest(f.orgId);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    members: [{ memberId: "CAM42", isOnline: true, profileRevision: 0 }],
  });
});
it("normalizes a valid crew record and inserts it with explicit tenant scope", async () => {
  const f = await fixture();
  const response = await mobileRequest(f.orgId, "", {
    ...f.input,
    memberId: " cam42 ",
    name: " Ada Operator ",
    email: " ADA@EXAMPLE.TEST ",
  });
  expect(response.status).toBe(201);
  expect(await f.row()).toMatchObject({
    orgId: f.orgId,
    memberId: "CAM42",
    name: "Ada Operator",
    email: "ada@example.test",
  });
});
it("rejects malformed or oversized photo payloads before writing", async () => {
  const f = await fixture();
  for (const photoUrl of [
    "data:text/html;base64,PHNjcmlwdD4=",
    "x".repeat(2_100_001),
  ]) {
    expect(
      (await mobileRequest(f.orgId, "", { ...f.input, photoUrl })).status,
    ).toBe(400);
  }
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
});
it("uses the crew id and organization together for updates", async () => {
  const f = await fixture();
  await mobileRequest(f.orgId, "", f.input);
  const row = await f.row();
  const response = await mobileRequest(f.orgId, `/${row.id}/update`, {
    ...f.input,
    requestId: crypto.randomUUID(),
    expectedRevision: 0,
    name: "Updated native",
  });
  expect(response.status).toBe(200);
  expect((await f.row()).name).toBe("Updated native");
});
it("returns not found when an update targets another tenant", async () => {
  const f = await fixture();
  const other = await seedRelayMember(crypto.randomUUID());
  const row = await getPrisma().crewMember.create({
    data: {
      orgId: other.orgId,
      memberId: "CAM42",
      name: "Foreign crew",
      role: "Camera",
    },
  });
  expect(
    (await mobileRequest(f.orgId, `/${row.id}/update`, f.input)).status,
  ).toBe(404);
  expect(
    (await getPrisma().crewMember.findUniqueOrThrow({ where: { id: row.id } }))
      .name,
  ).toBe("Foreign crew");
});
it("deletes only by crew id and organization id", async () => {
  const f = await fixture();
  await mobileRequest(f.orgId, "", f.input);
  const row = await f.row();
  expect(
    (
      await mobileRequest(f.orgId, `/${row.id}/remove`, {
        expectedRevision: 0,
        requestId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  expect(
    await getPrisma().crewMember.count({ where: { orgId: f.orgId } }),
  ).toBe(0);
});
it("requires permanent member-management permission", async () => {
  const f = await fixture();
  await getPrisma().member.updateMany({
    where: { organizationId: f.orgId, userId: f.userId },
    data: { role: "member" },
  });
  expect((await mobileRequest(f.orgId)).status).toBe(403);
  expect((await mobileRequest(f.orgId, "", f.input)).status).toBe(403);
});
