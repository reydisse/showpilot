import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), profile: vi.fn(), prisma: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => { const builder = { inputValidator: () => builder, handler: (handler: unknown) => handler }; return builder; } }));
vi.mock("../org-access", () => ({ assertOrgPermission: mocks.permission }));
vi.mock("../workspace/profile.server", () => ({ getWorkspaceProfileForOrg: mocks.profile }));
vi.mock("../db", () => ({ getPrisma: mocks.prisma }));
vi.mock("../rundown", () => ({ persistRundownItemsForOrg: vi.fn(), getRundownStateForOrg: vi.fn() }));
import { seedOrgTemplate } from "../onboarding";
beforeEach(() => { vi.clearAllMocks(); mocks.permission.mockResolvedValue({}); mocks.profile.mockResolvedValue({ type: "church" }); });
it("rejects a valid template belonging to another workspace type before opening its write store", async () => {
 await expect(seedOrgTemplate({ data: { orgId: "org-church", template: "two-act", serviceDate: "2026-10-06" } })).rejects.toThrow("Unknown template");
 expect(mocks.permission).toHaveBeenCalledWith("org-church", "rundown:edit");
 expect(mocks.profile).toHaveBeenCalledWith("org-church");
 expect(mocks.prisma).not.toHaveBeenCalled();
});
it("checks tenant access before looking up type or templates", async () => {
 mocks.permission.mockRejectedValue(new Error("Forbidden"));
 await expect(seedOrgTemplate({ data: { orgId: "someone-elses-org", template: "sunday", serviceDate: "2026-10-06" } })).rejects.toThrow("Forbidden");
 expect(mocks.profile).not.toHaveBeenCalled();
});
