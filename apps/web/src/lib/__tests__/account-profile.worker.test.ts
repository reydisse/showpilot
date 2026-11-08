import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import {
  readAccountProfile,
  writeAccountProfile,
} from "../account-profile.server";
import { handleAccountProfileRequest } from "../account-profile-api.server";
import {
  profileResultSchema,
  type ProfileCommand,
} from "../account-profile-contract";
import { getAuth } from "../auth";
import { getPrisma } from "../db";
import { seedRelayMember } from "@/test/relay-fixtures";

vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
const origin = "https://app.showpilot.tech";
let address = 0;
async function fixture() {
  const { userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-sign-out-92!";
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
  async function login() {
    const response = await getAuth().handler(
      new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          "cf-connecting-ip": `192.0.2.${++address}`,
        },
        body: JSON.stringify({ email: `${userId}@example.test`, password }),
      }),
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const current = await getAuth().api.getSession({
      headers: new Headers({ Cookie: cookie }),
      query: { disableCookieCache: true },
    });
    if (!current) throw new Error("Fixture login missing");
    return { cookie, sessionId: current.session.id };
  }
  return { userId, login, ...(await login()) };
}
const headers = (cookie: string) =>
  new Headers({ Cookie: cookie, Origin: origin });
function nameCommand(
  userId: string,
  name: string,
  expectedRevision: number,
): Extract<ProfileCommand, { kind: "name" }> {
  return {
    userId,
    kind: "name",
    name,
    requestId: crypto.randomUUID(),
    expectedRevision,
  };
}
async function photo(
  f: Awaited<ReturnType<typeof fixture>>,
  revision: number,
  bytes: number[],
  requestId = crypto.randomUUID(),
  storage: Pick<R2Bucket, "put"> = env.STORAGE,
) {
  const form = new FormData();
  form.set("userId", f.userId);
  form.set("requestId", requestId);
  form.set("expectedRevision", String(revision));
  form.set(
    "file",
    new File([new Uint8Array(bytes)], "avatar.jpg", { type: "image/jpeg" }),
  );
  return handleAccountProfileRequest(
    new Request(`${origin}/api/user/profile/photo`, {
      method: "POST",
      headers: headers(f.cookie),
      body: form,
    }),
    storage,
  );
}
it("does not replay an old name over a newer profile", async () => {
  const f = await fixture(),
    h = headers(f.cookie);
  const first = nameCommand(f.userId, "Original draft", 1);
  await writeAccountProfile(h, first);
  await writeAccountProfile(h, nameCommand(f.userId, "Newer profile", 2));
  expect(await writeAccountProfile(h, first)).toMatchObject({
    outcome: "superseded",
    state: { name: "Newer profile", revision: 3 },
  });
  expect(
    (await getPrisma().user.findUnique({ where: { id: f.userId } }))?.name,
  ).toBe("Newer profile");
});
it("binds a receipt to its original command and accepts one concurrent change per revision", async () => {
  const f = await fixture(),
    h = headers(f.cookie),
    first = nameCommand(f.userId, "First", 1);
  const results = await Promise.all([
    writeAccountProfile(h, first),
    writeAccountProfile(h, nameCommand(f.userId, "Second", 1)),
  ]);
  expect(results.map((r) => r.outcome).sort()).toEqual(["applied", "conflict"]);
  await expect(
    writeAccountProfile(h, { ...first, name: "Different" }),
  ).rejects.toThrow(/different profile/);
  expect((await readAccountProfile(h)).revision).toBe(2);
});
it("tracks legacy updates and rejects a stale revision after the name changes back", async () => {
  const f = await fixture(),
    h = headers(f.cookie),
    initial = await readAccountProfile(h);
  await getAuth().api.updateUser({ headers: h, body: { name: "Temporary" } });
  await getAuth().api.updateUser({ headers: h, body: { name: initial.name } });
  expect(
    (
      await writeAccountProfile(
        h,
        nameCommand(f.userId, "Stale", initial.revision),
      )
    ).outcome,
  ).toBe("conflict");
  expect(await readAccountProfile(h)).toMatchObject({
    name: initial.name,
    revision: initial.revision + 2,
  });
});
it("rolls back its receipt when storing the profile fails and retries once", async () => {
  const f = await fixture(),
    h = headers(f.cookie),
    command = nameCommand(f.userId, "Retry draft", 1);
  await env.DB.exec(
    "CREATE TRIGGER fixture_profile_failure BEFORE UPDATE OF name ON user BEGIN SELECT RAISE(ABORT,'fixture profile failure'); END;",
  );
  try {
    await expect(writeAccountProfile(h, command)).rejects.toThrow();
  } finally {
    await env.DB.exec("DROP TRIGGER fixture_profile_failure;");
  }
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM user_profile_receipt WHERE userId=?",
    )
      .bind(f.userId)
      .first(),
  ).toBeNull();
  expect((await readAccountProfile(h)).revision).toBe(1);
  const results = await Promise.all(
    Array.from({ length: 3 }, () => writeAccountProfile(h, command)),
  );
  expect(
    results.every((r) => r.outcome === "applied" && r.state.revision === 2),
  ).toBe(true);
});
it("stores immutable photos and cannot republish an old photo after a newer change", async () => {
  const f = await fixture(),
    firstId = crypto.randomUUID(),
    a = [255, 216, 255, 1, 255, 217],
    b = [255, 216, 255, 2, 255, 217];
  const first = profileResultSchema.parse(
    await (await photo(f, 1, a, firstId)).json(),
  );
  const second = profileResultSchema.parse(await (await photo(f, 2, b)).json());
  expect(first.state.image).not.toBe(second.state.image);
  if (!first.state.image) throw new Error("Expected a saved photo path");
  const firstObject = await env.STORAGE.get(
    first.state.image.replace("/api/user/avatar/", "avatars/"),
  );
  if (!firstObject) throw new Error("Expected stored photo bytes");
  expect([...new Uint8Array(await firstObject.arrayBuffer())]).toEqual(a);
  const replay = profileResultSchema.parse(
    await (await photo(f, 1, a, firstId)).json(),
  );
  expect(replay).toMatchObject({
    outcome: "superseded",
    state: { image: second.state.image, revision: 3 },
  });
  expect((await photo(f, 1, b, firstId)).status).toBe(409);
});
it("keeps the published photo unchanged when publication fails after storing bytes", async () => {
  const f = await fixture(),
    id = crypto.randomUUID(),
    bytes = [255, 216, 255, 3, 255, 217];
  await env.DB.exec(
    "CREATE TRIGGER fixture_photo_failure BEFORE UPDATE OF image ON user BEGIN SELECT RAISE(ABORT,'fixture photo publication failure'); END;",
  );
  try {
    expect((await photo(f, 1, bytes, id)).status).toBe(500);
  } finally {
    await env.DB.exec("DROP TRIGGER fixture_photo_failure;");
  }
  expect((await readAccountProfile(headers(f.cookie))).image).toBeNull();
  expect(
    (await env.STORAGE.list({ prefix: `avatars/${f.userId}/` })).objects,
  ).toHaveLength(1);
  expect(
    profileResultSchema.parse(await (await photo(f, 1, bytes, id)).json())
      .outcome,
  ).toBe("applied");
  expect(
    (await env.STORAGE.list({ prefix: `avatars/${f.userId}/` })).objects,
  ).toHaveLength(1);
});
it("rejects spoofed actors, revoked sessions, oversized bodies and foreign origins", async () => {
  const f = await fixture(),
    other = await fixture(),
    h = headers(f.cookie);
  await expect(
    writeAccountProfile(h, nameCommand(other.userId, "Spoofed", 1)),
  ).rejects.toThrow(/account changed/);
  const rejected = await handleAccountProfileRequest(
    new Request(`${origin}/api/user/profile`, {
      method: "POST",
      headers: {
        Cookie: f.cookie,
        Origin: "https://attacker.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(nameCommand(f.userId, "Foreign", 1)),
    }),
    env.STORAGE,
  );
  expect(rejected.status).toBe(403);
  const oversized = await handleAccountProfileRequest(
    new Request(`${origin}/api/user/profile`, {
      method: "POST",
      headers: { ...Object.fromEntries(h), "Content-Type": "application/json" },
      body: "x".repeat(4097),
    }),
    env.STORAGE,
  );
  expect(oversized.status).toBe(413);
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(f.sessionId)
    .run();
  await expect(
    writeAccountProfile(h, nameCommand(f.userId, "Revoked", 1)),
  ).rejects.toThrow(/sign in/i);
  await expect(readAccountProfile(h)).rejects.toThrow(/sign in/i);
});

it("never publishes a photo if storing the bytes fails", async () => {
  const f = await fixture(),
    requestId = crypto.randomUUID();
  const response = await photo(f, 1, [255, 216, 255, 3, 255, 217], requestId, {
    put: vi.fn().mockRejectedValue(new Error("Storage unavailable")),
  });
  expect(response.status).toBe(500);
  expect(await readAccountProfile(headers(f.cookie))).toMatchObject({
    image: null,
    revision: 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT requestId FROM user_profile_receipt WHERE userId=?",
    )
      .bind(f.userId)
      .first(),
  ).toBeNull();
  expect(
    profileResultSchema.parse(
      await (await photo(f, 1, [255, 216, 255, 3, 255, 217], requestId)).json(),
    ).outcome,
  ).toBe("applied");
});
