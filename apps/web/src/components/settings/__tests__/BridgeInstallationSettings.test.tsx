import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), rotate: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/bridge-installations", () => ({ getBridgeInstallations: api.list, createBridgeInstallation: api.create, rotateBridgeInstallationKey: api.rotate, revokeBridgeInstallationKey: api.revoke }));
import { BridgeInstallationSettings } from "../BridgeInstallationSettings";
const installation = { id: "installation-1", label: "Main room", createdAt: 1, lastUsedAt: null, revokedAt: null };
beforeEach(() => {
  vi.resetAllMocks(); api.list.mockResolvedValue([installation]);
  api.create.mockResolvedValue({ installationId: "installation-1", key: "sp_created_once" });
  api.rotate.mockResolvedValue({ installationId: "installation-1", key: "sp_rotated_once", previousKeysExpireAt: Date.now() + 600_000, connectionUpdated: true });
  api.revoke.mockResolvedValue({ revoked: true, connectionUpdated: true });
});
afterEach(cleanup);
describe("Bridge installation settings", () => {
  it("shows a newly issued key once and removes it when dismissed", async () => {
    render(<BridgeInstallationSettings orgId="org-1" />);
    await screen.findByText("Main room");
    expect(screen.queryByText(/sp_/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Installation name"), { target: { value: "  Backup room  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await screen.findByText("sp_created_once");
    expect(api.create).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-1", label: "Backup room" } });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss key" }));
    expect(screen.queryByText("sp_created_once")).toBeNull();
  });
  it("explains rotation overlap and revokes with one click", async () => {
    render(<BridgeInstallationSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    await screen.findByText("sp_rotated_once");
    expect(screen.getByText(/Previous keys remain valid for up to 10 minutes/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Revoke" }).hasAttribute("disabled")).toBe(false));
    api.list.mockResolvedValue([{ ...installation, revokedAt: Date.now() }]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await screen.findByText("Revoked");
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith({ data: { orgId: "org-1", installationId: "installation-1" } });
    expect(screen.queryByText("sp_rotated_once")).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
  it("discards late one-time keys after changing workspaces, including switching back", async () => {
    let finish: (value: { key: string }) => void = () => {};
    api.rotate.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<BridgeInstallationSettings orgId="org-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rotate key" }));
    view.rerender(<BridgeInstallationSettings orgId="org-2" />);
    await screen.findByText("Main room");
    view.rerender(<BridgeInstallationSettings orgId="org-1" />);
    await screen.findByText("Main room");
    await act(async () => { finish({ key: "sp_stale_key" }); });
    expect(screen.queryByText("sp_stale_key")).toBeNull();
  });
  it("keeps the secret visible when refreshing the installation list fails", async () => {
    render(<BridgeInstallationSettings orgId="org-1" />);
    await screen.findByText("Main room");
    api.list.mockRejectedValue(new Error("Connection lost while refreshing"));
    fireEvent.click(screen.getByRole("button", { name: "Rotate key" }));
    await screen.findByRole("alert");
    expect(screen.getByText("sp_rotated_once")).toBeTruthy();
  });
});
