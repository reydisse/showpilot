import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { handleMobileApi } from "../mobile-api.server";
import { mobileRundownSchema, rundownItemSchema } from "../../../../mobile/src/lib/rundown-schema";

vi.mock("../auth", () => ({ getAuth: () => ({ api: { getSession: async () => ({ user: { id: "contract-user", name: "Crew", email: "crew@example.test" } }) } }) }));
vi.mock("../effective-access", () => ({ resolveEffectiveAccess: async () => ({ role: "admin", permissions: ["rundown:view", "rundown:edit", "show:view"] }) }));

// This exercises the HTTP adapter directly, outside TanStack's generated router.
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeaders: () => new Headers() }));
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

const orgId = "mobile-contract-org";
const showId = "mobile-contract-show";

beforeAll(async () => {
  await env.DB.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Contract test', ?, CURRENT_TIMESTAMP)").bind(orgId, orgId).run();
  await env.DB.prepare(`INSERT INTO rundown (id, orgId, serviceDate, name, location, status, createdAt, updatedAt)
    VALUES (?, ?, '2026-09-30', 'Opening', 'Main room', 'draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(showId, orgId).run();
  await env.DB.prepare("INSERT INTO app_setting (id, orgId, key, value) VALUES ('contract-active', ?, 'active-show-id', ?)").bind(orgId, showId).run();
  for (const index of [0, 1]) {
    await env.DB.prepare(`INSERT INTO rundown_item
      (id, orgId, showId, serviceDate, itemId, title, type, duration, notes, assignee, cue, status, sortOrder, hardStop, createdAt, updatedAt)
      VALUES (?, ?, ?, '2026-09-30', ?, 'Welcome', 'segment', 60000, '', '', '', 'upcoming', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .bind(`contract-item-${index}`, orgId, showId, `item-${index}`, index).run();
  }
});

async function get(path: string) {
  const response = await handleMobileApi(new Request(`https://app.showpilot.tech/api/mobile/v1/${path}?orgId=${orgId}`), { DB: env.DB });
  expect(response?.status).toBe(200);
  if (!response) throw new Error("Route was not handled");
  return response.json();
}

describe("mobile rundown response contract", () => {
  it("opens the full rundown using the installed mobile schema and initializes unversioned snapshot rows", async () => {
    const detail = mobileRundownSchema.parse(await get(`rundowns/${showId}`));
    expect(detail.items.map(item => item.revision)).toEqual([0, 0]);
  });
  it("supplies the same item contract in the live-show workspace", async () => {
    const workspace = z.object({ runtime: z.object({ kind: z.literal("native"), items: z.array(rundownItemSchema) }) }).parse(await get("show-workspace"));
    expect(workspace.runtime.items.map(item => item.revision)).toEqual([0, 0]);
  });
});
