import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { nextFixtureAddress } from "@/test/fixture-address";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { handleMobileApi } from "../mobile-api.server";

vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
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
afterEach(() => abortAllDurableObjects());
const orgId = crypto.randomUUID(), otherOrg = crypto.randomUUID();
let userId = "", cookie = "";
const songId = crypto.randomUUID(), otherSongId = crypto.randomUUID();
beforeAll(async () => {
  const actor = await seedRelayMember(orgId); userId = actor.userId;
  await seedRelayMember(otherOrg);
  const password = "Disposable-timecode-show-password-92!";
  await getPrisma().account.create({ data: { id: crypto.randomUUID(), issuer: "local:credential", accountId: userId, providerId: "credential", userId, password: await hashPassword(password) } });
  await getPrisma().song.create({ data: { id: songId, orgId, title: "Fixture song", ppPresentationUuid: "presentation" } });
  await getPrisma().song.create({ data: { id: otherSongId, orgId: otherOrg, title: "Private song" } });
  await getPrisma().songSection.create({ data: { id: "first-section", orgId, songId, label: "Verse", lyrics: "Line one\nLine two", sourceSlideIndex: 0, sortOrder: 0 } });
  await getPrisma().songSection.create({ data: { id: "next-section", orgId, songId, label: "Chorus", lyrics: "Sing", sourceSlideIndex: 1, sortOrder: 1 } });
  for (const [id, organization, enabled] of [["visible-device", orgId, 1], ["disabled-device", orgId, 0], ["private-device", otherOrg, 1]] as const)
    await env.DB.prepare("INSERT INTO device(id, orgId, name, category, adapterType, settings, enabled, createdAt, updatedAt) VALUES(?,?,?,'video','atem',?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(id, organization, id, JSON.stringify({ host: "10.0.0.2", password: "fixture-secret" }), enabled).run();
  const login = await getAuth().handler(new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.showpilot.tech", "cf-connecting-ip": nextFixtureAddress() },
    body: JSON.stringify({ email: `${userId}@example.test`, password }),
  }));
  expect(login.status).toBe(200); await login.arrayBuffer();
  cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
});

async function call(kind: string, song = "", organization = orgId, session = cookie) {
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/timecode/choices?${new URLSearchParams({ orgId: organization, kind, songId: song })}`, { headers: { Cookie: session } }), env);
  if (!response) throw new Error("Missing cue-choice route");
  return { status: response.status, body: await response.json() };
}
it("lists only this organization's songs and ordered sections with line breaks intact", async () => {
  expect(await call("songs")).toEqual({ status: 200, body: { songs: [{ id: songId, title: "Fixture song", ppPresentationUuid: "presentation" }] } });
  expect(await call("sections", songId)).toMatchObject({ status: 200, body: { id: songId, sections: [
    { id: "first-section", label: "Verse", lyrics: "Line one\nLine two", sourceSlideIndex: 0 }, { id: "next-section", label: "Chorus" },
  ] } });
});
it("returns enabled device action schemas without configuration or credentials", async () => {
  const response = await call("devices"); expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ devices: [{ id: "visible-device", actionSource: "static", actions: expect.arrayContaining([expect.objectContaining({ id: "set_program_input" })]) }] });
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toMatch(/fixture-secret|10\.0\.0\.2|password|settings|private-device|disabled-device/);
});
it("requires both timecode and domain access", async () => {
  try {
    await env.DB.prepare("UPDATE member SET role='pm' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
    expect((await call("songs")).status).toBe(200); expect((await call("devices")).status).toBe(403);
    await env.DB.prepare("UPDATE member SET role='member' WHERE organizationId=? AND userId=?").bind(orgId, userId).run();
    expect((await call("songs")).status).toBe(403);
  } finally { await env.DB.prepare("UPDATE member SET role='owner' WHERE organizationId=? AND userId=?").bind(orgId, userId).run(); }
});
it("rejects another organization's song or catalog and unauthenticated requests", async () => {
  expect((await call("sections", otherSongId)).status).toBe(404);
  expect((await call("songs", "", otherOrg)).status).toBe(401);
  expect((await call("songs", "", orgId, "")).status).toBe(401);
  expect((await call("sections")).status).toBe(400);
  expect((await call("unknown")).status).toBe(400);
});
