import { expect, it, vi } from "vitest";
import { WORKSPACE_SETTING_KEYS } from "@showpilot/shared";
const mocks = vi.hoisted(() => ({ prisma: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
 let validate = (data: unknown) => data;
 const builder = { inputValidator: (validator: typeof validate) => { validate = validator; return builder; }, handler: (handler: (input: unknown) => unknown) => async (input: { data: unknown }) => handler({ data: validate(input.data) }) };
 return builder;
} }));
vi.mock("../db", () => ({ getPrisma: mocks.prisma }));
import { updateOrgSetting, bulkUpdateOrgSettings } from "../settings";
it.each(WORKSPACE_SETTING_KEYS)("cannot bypass the workspace command contract through generic setting %s", async key => {
 const entry = { key, value: "unvalidated" };
 await expect(updateOrgSetting({ data: { orgId: "workspace-org", ...entry } })).rejects.toThrow("Use Workspace settings");
 await expect(bulkUpdateOrgSettings({ data: { orgId: "workspace-org", settings: [entry] } })).rejects.toThrow("Use Workspace settings");
 expect(mocks.prisma).not.toHaveBeenCalled();
});
