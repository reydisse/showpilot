import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  permission: vi.fn(), issue: vi.fn(), list: vi.fn(), rotate: vi.fn(), revoke: vi.fn(), migrate: vi.fn(), refresh: vi.fn(),
  db: { fixture: true },
}));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (data: unknown) => data;
  const builder = {
    inputValidator: (validator: typeof validate) => { validate = validator; return builder; },
    handler: (handler: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => handler({ data: validate(input.data) }),
  };
  return builder;
} }));
vi.mock("cloudflare:workers", () => ({ env: { DB: mocks.db, BRIDGE_RELAY: { getByName: () => ({ refreshCredentialAuthority: mocks.refresh }) } } }));
vi.mock("../org-access", () => ({ assertOrgPermission: mocks.permission }));
vi.mock("../bridge-credentials.server", () => ({
  issueBridgeInstallation: mocks.issue, listBridgeInstallations: mocks.list, migrateLegacyBridgeInstallation: mocks.migrate,
  rotateBridgeInstallation: mocks.rotate, revokeBridgeInstallation: mocks.revoke,
}));
import { createBridgeInstallation, getBridgeInstallations, revokeBridgeInstallationKey, rotateBridgeInstallationKey } from "../bridge-installations";
const actor = { orgId: "org-1", installationId: "installation-1" };
beforeEach(() => {
  vi.resetAllMocks(); mocks.permission.mockResolvedValue({ user: { id: "owner-1" } });
  mocks.issue.mockResolvedValue({ installationId: "installation-1", key: "sp_new" });
  mocks.rotate.mockResolvedValue({ installationId: "installation-1", key: "sp_rotated", previousKeysExpireAt: 600_000 });
  mocks.list.mockResolvedValue([]);
});
describe("Bridge installation management authorization", () => {
  it("requires key-management permission before any store or connection operation", async () => {
    mocks.permission.mockRejectedValue(new Error("Forbidden"));
    for (const action of [
      () => getBridgeInstallations({ data: { orgId: "org-1" } }),
      () => createBridgeInstallation({ data: { orgId: "org-1", label: "Venue" } }),
      () => rotateBridgeInstallationKey({ data: actor }),
      () => revokeBridgeInstallationKey({ data: actor }),
    ]) await expect(action()).rejects.toThrow("Forbidden");
    expect(mocks.permission.mock.calls).toEqual(Array.from({ length: 4 }, () => ["org-1", "settings:api_keys"]));
    for (const fn of [mocks.issue, mocks.list, mocks.migrate, mocks.rotate, mocks.revoke, mocks.refresh]) expect(fn).not.toHaveBeenCalled();
  });
  it("validates and trims labels and records the authenticated actor", async () => {
    for (const label of ["", " ", "x".repeat(81)]) await expect(createBridgeInstallation({ data: { orgId: "org-1", label } })).rejects.toThrow();
    expect(mocks.permission).not.toHaveBeenCalled();
    await expect(createBridgeInstallation({ data: { orgId: "org-1", label: "  Venue  " } })).resolves.toMatchObject({ key: "sp_new" });
    expect(mocks.issue).toHaveBeenCalledExactlyOnceWith(mocks.db, { orgId: "org-1", label: "Venue", actorUserId: "owner-1" });
  });
  it("preserves the one-time rotation result even when connection refresh fails", async () => {
    mocks.refresh.mockRejectedValue(new Error("Relay unavailable"));
    await expect(rotateBridgeInstallationKey({ data: actor })).resolves.toMatchObject({ key: "sp_rotated", connectionUpdated: false });
    expect(mocks.rotate).toHaveBeenCalledExactlyOnceWith(mocks.db, { ...actor, actorUserId: "owner-1" });
  });
  it("commits revocation before refreshing the live socket", async () => {
    mocks.revoke.mockImplementation(async () => { expect(mocks.refresh).not.toHaveBeenCalled(); });
    await expect(revokeBridgeInstallationKey({ data: actor })).resolves.toEqual({ revoked: true, connectionUpdated: true });
    expect(mocks.revoke).toHaveBeenCalledExactlyOnceWith(mocks.db, { ...actor, actorUserId: "owner-1" });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
