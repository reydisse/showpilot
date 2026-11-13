import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { hashPassword } from "better-auth/crypto";
import { getAuth } from "../auth";
import { readWorkspaceChange, writeWorkspaceChange } from "../workspace/change.server";
import { getWorkspaceChange, saveWorkspaceChange } from "../workspace/change";
import { writeWorkspaceProfile, workspaceD1Store } from "../workspace/profile.server";
import { handleMobileApi } from "../mobile-api.server";
import { CORE_MODULES } from "@showpilot/shared";
import { workspaceChangeResultSchema, type WorkspaceChange } from "@showpilot/shared/workspace-change";
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
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

async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-workspace-password-92!";
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
    .map((value) => value.split(";")[0])
    .join("; ");
  return { orgId, userId, headers: new Headers({ Cookie: auth.cookie }) };
}

function command(f: { orgId: string; userId: string }, operation: WorkspaceChange["operation"], expectedRevision: string | null = null): WorkspaceChange {
  return { orgId: f.orgId, userId: f.userId, requestId: crypto.randomUUID(), expectedRevision, operation };
}
const disableChat = { kind: "module", module: "chat", enabled: false } as const;
const read = (f: { orgId: string; userId: string }) => getWorkspaceChange({ data: { orgId: f.orgId, userId: f.userId } });
it("saves a desired feature and retains all unrelated features and core modules", async () => {
  const f = await fixture();
  const result = await saveWorkspaceChange({ data: command(f, disableChat) });
  expect(result.outcome).toBe("applied");
  expect(result.snapshot.profile.modules).not.toContain("chat");
  expect(result.snapshot.profile.modules).toContain("songs");
  const core = await writeWorkspaceChange(f.headers, command(f, { kind: "module", module: "show", enabled: false }, result.snapshot.revision), "save");
  expect(core.snapshot.profile.modules).toEqual(expect.arrayContaining([...CORE_MODULES]));
});
it("rejects an old page's change without undoing another administrator's choice", async () => {
  const f = await fixture();
  const old = command(f, disableChat);
  await saveWorkspaceChange({ data: command(f, { kind: "module", module: "songs", enabled: false }) });
  const result = await saveWorkspaceChange({ data: old });
  expect(result.outcome).toBe("conflict");
  expect(result.snapshot.profile.modules).not.toContain("songs");
  expect(result.snapshot.profile.modules).toContain("chat");
});
it("retries a lost reply without reapplying after a later change", async () => {
  const f = await fixture(), first = command(f, disableChat);
  const result = await saveWorkspaceChange({ data: first });
  expect((await saveWorkspaceChange({ data: first })).snapshot.revision).toBe(result.snapshot.revision);
  const later = await saveWorkspaceChange({ data: command(f, { ...disableChat, enabled: true }, result.snapshot.revision) });
  const retry = await saveWorkspaceChange({ data: first });
  expect(retry.outcome).toBe("superseded"); expect(retry.snapshot.revision).toBe(later.snapshot.revision);
  expect(retry.snapshot.profile.modules).toContain("chat");
});
it("rejects reuse of a request ID with different input", async () => {
  const f = await fixture(), first = command(f, disableChat);
  const result = await saveWorkspaceChange({ data: first });
  await expect(saveWorkspaceChange({ data: { ...first, operation: { ...disableChat, enabled: true } } })).rejects.toThrow("different workspace change");
  expect((await read(f)).revision).toBe(result.snapshot.revision);
});
it("review cancels an uncommitted request and fences its delayed save", async () => {
  const f = await fixture(), first = command(f, disableChat);
  expect((await writeWorkspaceChange(f.headers, first, "review")).outcome).toBe("cancelled");
  expect((await saveWorkspaceChange({ data: first })).outcome).toBe("cancelled");
  expect((await read(f)).profile.modules).toContain("chat");
});
it("concurrent saves from one revision cannot both overwrite the profile", async () => {
  const f = await fixture();
  const results = await Promise.all([disableChat, { kind: "module", module: "songs", enabled: false } as const].map(operation => writeWorkspaceChange(f.headers, command(f, operation), "save")));
  expect(results.map(result => result.outcome).sort()).toEqual(["applied", "conflict"]);
});
it("preserves feature selection when changing type unless reset was requested", async () => {
  const f = await fixture(); const first = await saveWorkspaceChange({ data: command(f, disableChat) });
  const changed = await saveWorkspaceChange({ data: command(f, { kind: "type", type: "school", resetModules: false }, first.snapshot.revision) });
  expect(changed.snapshot.profile.type).toBe("school"); expect(changed.snapshot.profile.modules).not.toContain("chat");
  const stored = await env.DB.prepare("SELECT value FROM app_setting WHERE orgId=? AND key='terminology-profile'").bind(f.orgId).first<{ value: string }>();
  expect(stored?.value).toBe("general");
});
it("applies custom names only while the reviewed workspace remains customizable", async () => {
  const f = await fixture();
  const custom = await saveWorkspaceChange({ data: command(f, { kind: "type", type: "custom", resetModules: false }) });
  const names = command(f, { kind: "custom", custom: { label: "Tour", terms: { event: "Gig" } } }, custom.snapshot.revision);
  const result = await saveWorkspaceChange({ data: names }); expect(result.snapshot.profile.label).toBe("Tour");
  const school = await saveWorkspaceChange({ data: command(f, { kind: "type", type: "school", resetModules: false }, result.snapshot.revision) });
  const rejected = await saveWorkspaceChange({ data: { ...names, requestId: crypto.randomUUID(), expectedRevision: school.snapshot.revision } });
  expect(rejected.outcome).toBe("conflict");
});
it("detects older compatible writers through the existing workspace revision", async () => {
  const f = await fixture(); const old = command(f, disableChat);
  await writeWorkspaceProfile(workspaceD1Store(env.DB, f.orgId), { kind: "type", type: "theatre", resetModules: true });
  expect((await saveWorkspaceChange({ data: old })).outcome).toBe("conflict");
  expect((await read(f)).profile.type).toBe("theatre");
});
it.each(["member", "viewer"])("does not allow a %s to read or write management state", async role => {
  const f = await fixture(); await env.DB.prepare("UPDATE member SET role=? WHERE organizationId=? AND userId=?").bind(role, f.orgId, f.userId).run();
  await expect(read(f)).rejects.toThrow("permission");
  await expect(saveWorkspaceChange({ data: command(f, disableChat) })).rejects.toThrow("permission");
});
it("isolates organizations, accounts and revoked sessions", async () => {
  const f = await fixture();
  await expect(readWorkspaceChange(f.headers, { orgId: crypto.randomUUID(), userId: f.userId })).rejects.toThrow("permission");
  await expect(readWorkspaceChange(f.headers, { orgId: f.orgId, userId: "other" })).rejects.toThrow("account");
  await env.DB.prepare("DELETE FROM session WHERE userId=?").bind(f.userId).run();
  await expect(writeWorkspaceChange(f.headers, command(f, disableChat), "save")).rejects.toThrow("account");
});
it("serves native read, save and review through the same validated contract", async () => {
  const f = await fixture(), input = command(f, disableChat);
  const request = (path: string, body?: unknown) => handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/workspace/${path}`, { method: body ? "POST" : "GET", headers: { Cookie: auth.cookie, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: env.DB });
  const state = await request(`change?orgId=${f.orgId}&userId=${f.userId}`); expect(state?.status).toBe(200);
  const saved = await request("change", input); expect(saved?.status).toBe(200);
  expect(workspaceChangeResultSchema.parse(await saved!.json()).outcome).toBe("applied");
  const reviewed = await request("review-change", input); expect(workspaceChangeResultSchema.parse(await reviewed!.json()).outcome).toBe("applied");
  expect((await request("change", { ...input, operation: { kind: "module", module: "unknown", enabled: false } }))?.status).toBe(400);
  expect((await request("change", { ...input, userId: "other" }))?.status).toBe(403);
});
