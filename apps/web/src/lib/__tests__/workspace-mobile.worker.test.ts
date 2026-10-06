import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  WORKSPACE_TYPES,
  CORE_MODULES,
  DEFAULT_WORKSPACE_MODULES,
} from "@showpilot/shared";
import { handleMobileApi } from "../mobile-api.server";
const mocks = vi.hoisted(() => ({
  role: "owner",
  permissions: ["settings:organization", "schedule:view", "schedule:manage"],
  allowed: true,
}));
vi.mock("../auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({
        user: {
          id: "workspace-contract-user",
          name: "Crew",
          email: "crew@example.test",
        },
      }),
    },
  }),
}));
vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: async () =>
    mocks.allowed ? { role: mocks.role, permissions: mocks.permissions } : null,
  resolveAccessGrantAuthorityForAccess: async () => null,
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
  return { createServerFn: builder, createMiddleware: builder };
});
const orgId = "workspace-contract-org";
beforeAll(async () => {
  await env.DB.prepare(
    "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Workspace contract', ?, CURRENT_TIMESTAMP)",
  )
    .bind(orgId, orgId)
    .run();
});
beforeEach(async () => {
  mocks.role = "owner";
  mocks.permissions = [
    "settings:organization",
    "schedule:view",
    "schedule:manage",
  ];
  mocks.allowed = true;
  await env.DB.prepare("DELETE FROM app_setting WHERE orgId = ?")
    .bind(orgId)
    .run();
});
async function request(path: string, body?: Record<string, unknown>) {
  const response = await handleMobileApi(
    new Request(
      `https://app.showpilot.tech/api/mobile/v1/${path}?orgId=${orgId}`,
      body
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : undefined,
    ),
    { DB: env.DB },
  );
  if (!response) throw new Error("Unhandled route");
  return response;
}
async function setting(key: string, value: string) {
  await env.DB.prepare(
    "INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value",
  )
    .bind(crypto.randomUUID(), orgId, key, value)
    .run();
}
const profileSchema = z.object({
  workspace: z.object({
    type: z.string(),
    modules: z.array(z.string()),
    isExplicit: z.boolean(),
  }),
});
describe("workspace mobile HTTP and D1 contract", () => {
  it.each(WORKSPACE_TYPES)(
    "keeps installed Schedule schemas compatible with %s",
    async (type) => {
      await setting("workspace-type", type);
      const response = await request("schedule");
      expect(response.status).toBe(200);
      const result = z
        .object({
          terminologyProfile: z.enum(["general", "church"]),
          workspaceType: z.string(),
        })
        .parse(await response.json());
      expect(result.workspaceType).toBe(type);
      expect(result.terminologyProfile).toBe(
        type === "church" ? "church" : "general",
      );
    },
  );
  it("resolves bootstrap for missing, legacy and explicit settings", async () => {
    expect(
      profileSchema.parse(await (await request("bootstrap")).json()).workspace,
    ).toMatchObject({ type: "church", isExplicit: false });
    await setting("terminology-profile", "general");
    expect(
      profileSchema.parse(await (await request("bootstrap")).json()).workspace
        .type,
    ).toBe("live_events");
    await setting("workspace-type", "theatre");
    expect(
      profileSchema.parse(await (await request("bootstrap")).json()).workspace,
    ).toMatchObject({ type: "theatre", isExplicit: true });
  });
  it("initializes atomically once and refuses a stale second initial request", async () => {
    const first = await request("workspace/initial", { type: "theatre" });
    expect(first.status).toBe(200);
    expect(profileSchema.parse(await first.json()).workspace.modules).toEqual(
      DEFAULT_WORKSPACE_MODULES.theatre,
    );
    expect(
      (await request("workspace/initial", { type: "school" })).status,
    ).toBe(409);
    expect(
      profileSchema.parse(await (await request("bootstrap")).json()).workspace
        .type,
    ).toBe("theatre");
  });
  it("requires owner for initial and settings permission for changes", async () => {
    mocks.role = "admin";
    expect(
      (await request("workspace/initial", { type: "school" })).status,
    ).toBe(403);
    expect(
      (await request("workspace/type", { type: "school", resetModules: false }))
        .status,
    ).toBe(200);
    mocks.role = "member";
    mocks.permissions = ["schedule:view"];
    expect(
      (await request("workspace/type", { type: "church", resetModules: false }))
        .status,
    ).toBe(403);
    expect(
      (await request("workspace/modules", { modules: ["chat"] })).status,
    ).toBe(403);
    mocks.allowed = false;
    expect((await request("bootstrap")).status).toBe(401);
  });
  it("rejects invalid values and restores core modules", async () => {
    expect(
      (await request("workspace/type", { type: "film", resetModules: false }))
        .status,
    ).toBe(400);
    expect(
      (await request("workspace/modules", { modules: ["unknown"] })).status,
    ).toBe(400);
    expect(
      profileSchema.parse(
        await (await request("workspace/modules", { modules: [] })).json(),
      ).workspace.modules,
    ).toEqual(CORE_MODULES);
  });
  it("omitted and general legacy provider fields preserve a theatre workspace and its modules", async () => {
    await setting("workspace-type", "theatre");
    await setting("workspace-modules", '["chat"]');
    for (const field of [{}, { terminologyProfile: "general" }]) {
      const response = await request("schedule/provider", {
        provider: "native",
        url: "",
        token: "",
        ...field,
      });
      expect(response.status).toBe(200);
      expect(
        profileSchema.parse(await (await request("bootstrap")).json())
          .workspace,
      ).toMatchObject({ type: "theatre", modules: [...CORE_MODULES, "chat"] });
    }
  });
});
