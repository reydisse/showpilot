import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  permission: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (data: unknown) => unknown) => ({
      handler:
        (handler: (input: unknown) => unknown) => (input: { data: unknown }) =>
          handler({ data: validate(input.data) }),
    }),
  }),
}));
vi.mock("../org-access", () => ({
  getRequestOrgAccess: mocks.access,
  assertOrgPermission: mocks.permission,
}));
vi.mock("../workspace/profile.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  workspacePrismaStore: async () => ({ read: mocks.read, write: mocks.write }),
}));
import {
  getWorkspaceProfile,
  saveWorkspaceType,
  setWorkspaceType,
  setWorkspaceModules,
  setWorkspaceCustom,
} from "../workspace/profile";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ "workspace-type": "custom" });
  mocks.write.mockImplementation(async (entries: [string, string][]) => { const current = await mocks.read(); mocks.read.mockResolvedValue({ ...current, ...Object.fromEntries(entries) }); });
});
const orgId = "workspace-permission-org";
const changes = [
  () =>
    setWorkspaceType({ data: { orgId, type: "theatre", resetModules: false } }),
  () => setWorkspaceModules({ data: { orgId, modules: ["chat"] } }),
  () =>
    setWorkspaceCustom({
      data: { orgId, label: "Tour", terms: { event: "Gig" } },
    }),
];
describe("workspace web authorization", () => {
  it("rejects members before reading or writing settings", async () => {
    mocks.permission.mockRejectedValue(new Error("Forbidden"));
    for (const change of changes)
      await expect(change()).rejects.toThrow("Forbidden");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.permission).toHaveBeenCalledWith(
      orgId,
      "settings:organization",
    );
  });
  it.each(["owner", "admin"])(
    "allows %s through the existing settings permission",
    async (role) => {
      mocks.permission.mockResolvedValue({ access: { role } });
      for (const change of changes) {
        mocks.read.mockResolvedValue({ "workspace-type": "custom" });
        await expect(change()).resolves.toBeDefined();
      }
      expect(mocks.write).toHaveBeenCalledTimes(3);
    },
  );
  it("limits onboarding to the owner", async () => {
    for (const role of ["member", "admin"]) {
      mocks.access.mockResolvedValue({ access: { role } });
      await expect(
        saveWorkspaceType({ data: { orgId, type: "school" } }),
      ).rejects.toThrow("Forbidden");
    }
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.access.mockResolvedValue({ access: { role: "owner" } });
    await expect(
      saveWorkspaceType({ data: { orgId, type: "school" } }),
    ).resolves.toMatchObject({ type: "school" });
  });
  it("rejects an unrelated organization on every entry point", async () => {
    mocks.access.mockRejectedValue(new Error("Forbidden"));
    mocks.permission.mockRejectedValue(new Error("Forbidden"));
    for (const change of [
      () => getWorkspaceProfile({ data: { orgId } }),
      () => saveWorkspaceType({ data: { orgId, type: "school" } }),
      ...changes,
    ])
      await expect(change()).rejects.toThrow("Forbidden");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
