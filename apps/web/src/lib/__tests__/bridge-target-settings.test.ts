import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ permission: vi.fn(), change: vi.fn(), getByName: vi.fn(), list: vi.fn(), db: { fixture: true } }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => {
  let validate = (data: unknown) => data;
  const builder = {
    inputValidator: (validator: typeof validate) => { validate = validator; return builder; },
    handler: (handler: (input: { data: unknown }) => unknown) => async (input: { data: unknown }) => handler({ data: validate(input.data) }),
  };
  return builder;
} }));
vi.mock("cloudflare:workers", () => ({ env: { DB: mocks.db, BRIDGE_RELAY: { getByName: mocks.getByName } } }));
vi.mock("../org-access", () => ({ assertOrgPermission: mocks.permission }));
vi.mock("../bridge-targets.server", () => ({ listBridgeTargets: mocks.list }));
import { approveBridgeDestination, getBridgeTargetPolicy, removeBridgeDestination } from "../bridge-target-settings";
const input = { orgId: "org-1", label: " Venue OBS ", host: "VENUE.LOCAL", port: "4455", protocol: "obs" };
beforeEach(() => { vi.resetAllMocks(); mocks.permission.mockResolvedValue({ user: { id: "admin" } }); mocks.list.mockResolvedValue([]); mocks.getByName.mockReturnValue({ changeTargetApproval: mocks.change }); mocks.change.mockResolvedValue({ targets: [], warning: null }); });

describe("Bridge destination management authorization", () => {
  it("requires API-key or integration management before every read or mutation", async () => {
    mocks.permission.mockRejectedValue(new Error("Forbidden"));
    for (const action of [
      () => getBridgeTargetPolicy({ data: { orgId: "org-1" } }),
      () => approveBridgeDestination({ data: input }),
      () => removeBridgeDestination({ data: { orgId: "org-1", id: "destination", confirmed: true } }),
    ]) await expect(action()).rejects.toThrow("Forbidden");
    expect(mocks.permission.mock.calls).toEqual(Array.from({ length: 3 }, () => ["org-1", ["settings:api_keys", "settings:integrations"]]));
    for (const fn of [mocks.change, mocks.getByName, mocks.list]) expect(fn).not.toHaveBeenCalled();
  });
  it("records the authenticated actor and canonical endpoint, ignoring client-supplied attribution", async () => {
    await approveBridgeDestination({ data: { ...input, actorUserId: "spoofed" } as typeof input });
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith({ action: "approve", orgId: "org-1", label: "Venue OBS", endpoint: { host: "venue.local", port: 4455, protocol: "obs" }, actorUserId: "admin" });
    expect(mocks.getByName).toHaveBeenCalledExactlyOnceWith("org-1");
  });
  it("validates before touching storage and requires explicit removal confirmation", async () => {
    await expect(approveBridgeDestination({ data: { ...input, host: "https://user:private@host" } })).rejects.toThrow("valid Bridge host");
    await expect(approveBridgeDestination({ data: { ...input, label: " " } })).rejects.toThrow();
    await expect(removeBridgeDestination({ data: { orgId: "org-1", id: "destination", confirmed: false as true } })).rejects.toThrow();
    expect(mocks.change).not.toHaveBeenCalled();
    await removeBridgeDestination({ data: { orgId: "org-1", id: "destination", confirmed: true } });
    expect(mocks.change).toHaveBeenCalledExactlyOnceWith({ action: "remove", orgId: "org-1", id: "destination", actorUserId: "admin" });
  });
});
