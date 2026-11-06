import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueDisplayPass } from "../display-access.server";
const mocks = vi.hoisted(() => ({ request: vi.fn(), org: vi.fn(), setting: vi.fn(), settings: vi.fn(), shows: vi.fn(), templates: vi.fn(), rundown: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (data: unknown) => data;
  const builder = { inputValidator: (validator: typeof validate) => { validate = validator; return builder; }, handler: (handler: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => handler({ data: validate(input.data) }) }; return builder;
} }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.request, getRequestHeaders: () => mocks.request().headers }));
vi.mock("cloudflare:workers", () => ({ env: { KIOSK_SECRET: "display-data-fixture", DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } }));
vi.mock("../db", () => ({ getPrisma: () => ({
  organization: { findUnique: mocks.org }, appSetting: { findUnique: mocks.setting, findMany: mocks.settings },
  rundown: { findMany: mocks.shows }, graphicTemplate: { findMany: mocks.templates },
}) }));
vi.mock("../rundown", () => ({ getRundownStateForOrg: mocks.rundown }));
import { getRundownStateBySlug } from "../display-data";
import { getDisplaySettingsBySlug } from "../settings";
import { handleOverlayGet } from "../../routes/api/overlay/$orgSlug";
beforeEach(() => {
  vi.resetAllMocks(); mocks.org.mockResolvedValue({ id: "org-1" });
  mocks.request.mockReturnValue(new Request("https://app.example/_serverFn/fixture"));
  mocks.settings.mockResolvedValue([]); mocks.shows.mockResolvedValue([]);
  mocks.setting.mockResolvedValue(null);
  mocks.rundown.mockResolvedValue({ items: [{ id: "item-1", title: "Welcome", notes: "Private operator note", script: "Private script" }], timer: {} });
});
describe("display data boundaries", () => {
  it("rejects anonymous fallback state and settings before reading any show data", async () => {
    await expect(getRundownStateBySlug({ data: { orgSlug: "venue", serviceDate: "2026-11-04" } })).rejects.toThrow("display pass");
    await expect(getDisplaySettingsBySlug({ data: { orgSlug: "venue" } })).rejects.toThrow("display pass");
    for (const fn of [mocks.setting, mocks.settings, mocks.shows, mocks.rundown]) expect(fn).not.toHaveBeenCalled();
  });
  it("returns stage messages only behind a timer pass and keeps private item notes out of the projection", async () => {
    const pass = await issueDisplayPass("org-1", "timer", "display-data-fixture");
    mocks.request.mockReturnValue(new Request("https://app.example/_serverFn/fixture", { headers: { "x-showpilot-display-pass": pass.token } }));
    mocks.setting.mockImplementation(async (args: { where: { orgId_key: { key: string } } }) => args.where.orgId_key.key.startsWith("rundown-message:") ? { value: "Private stage message" } : null);
    const result = await getRundownStateBySlug({ data: { orgSlug: "venue", serviceDate: "2026-11-04" } });
    expect(result?.message).toBe("Private stage message");
    expect(JSON.stringify(result)).not.toContain("Private operator note");
    expect(JSON.stringify(result)).not.toContain("Private script");
  });
  it("rejects anonymous overlay requests and sends no wildcard CORS or cacheable responses", async () => {
    const response = await handleOverlayGet({ params: { orgSlug: "venue" }, request: new Request("https://app.example/api/overlay/venue") });
    expect(response.status).toBe(401);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.setting).not.toHaveBeenCalled(); expect(mocks.templates).not.toHaveBeenCalled();
  });
  it("returns only the authorized organization's active graphics in their display order", async () => {
    const pass = await issueDisplayPass("org-1", "overlay", "display-data-fixture");
    mocks.setting.mockResolvedValue({ value: '["graphic-b","graphic-a"]' });
    mocks.templates.mockResolvedValue([{ id: "graphic-a", title: "A" }, { id: "graphic-b", title: "B" }]);
    const response = await handleOverlayGet({ params: { orgSlug: "venue" }, request: new Request("https://app.example/api/overlay/venue", { headers: { "x-showpilot-display-pass": pass.token } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "graphic-b", title: "B" }, { id: "graphic-a", title: "A" }]);
    expect(mocks.templates).toHaveBeenCalledWith({ where: { id: { in: ["graphic-b", "graphic-a"] }, orgId: "org-1" } });
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
});
