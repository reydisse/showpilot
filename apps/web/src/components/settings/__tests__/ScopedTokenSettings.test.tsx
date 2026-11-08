vi.mock("../KioskDutyRoster", () => ({ KioskDutyRoster: () => null }));
vi.mock("../KioskTeamEditor", () => ({ KioskTeamEditor: () => null }));
vi.mock("../KioskDisplayControl", () => ({ KioskDisplayControl: () => null }));
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("@/lib/companion", () => ({
  createCompanionToken: api.create,
  listCompanionTokens: api.list,
  revokeCompanionToken: api.revoke,
}));
vi.mock("@/lib/kiosk", () => ({
  createKioskToken: api.create,
  listKioskTokens: api.list,
  revokeKioskToken: api.revoke,
}));
vi.mock("@/lib/kiosk-display", () => ({
  getKioskBlankState: async () => false,
  setKioskBlankState: vi.fn(),
}));
vi.mock("@/lib/kiosk-admin", () => ({ getKioskTeams: async () => [] }));
import { CompanionSection } from "../CompanionSection";
import { KioskSection } from "../KioskSection";

const row = {
  id: "existing",
  label: "Existing device",
  createdAt: new Date(),
  expiresAt: null,
};
const created = {
  ...row,
  id: "new-token",
  label: "New device",
  token: "fixture-only-bearer-token",
};
beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue([row]);
  api.create.mockResolvedValue(created);
  api.revoke.mockResolvedValue({ id: row.id, revokedAt: new Date() });
});
afterEach(cleanup);
async function open(kind: "kiosk" | "companion", orgId = "org-1") {
  const view = render(
    kind === "kiosk" ? (
      <KioskSection
        userId="fixture-user"
        orgId={orgId}
        slug={orgId}
        members={[]}
      />
    ) : (
      <CompanionSection orgId={orgId} slug={orgId} />
    ),
  );
  if (kind === "kiosk")
    fireEvent.click(
      await screen.findByRole("button", { name: "Access Tokens" }),
    );
  await screen.findAllByText("Existing device");
  return view;
}

it.each(["kiosk", "companion"] as const)(
  "shows a new %s token once, removes it on dismiss, and cannot reveal an existing token",
  async (kind) => {
    const view = await open(kind);
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/Token label/), {
      target: { value: "New device" },
    });
    api.list.mockResolvedValue([row, { ...created, token: undefined }]);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(
      ((await screen.findByLabelText("New token")) as HTMLTextAreaElement)
        .value,
    ).toBe(created.token);
    expect(
      (screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss token" }));
    expect(screen.queryByLabelText("New token")).toBeNull();
    expect(document.body.textContent).not.toContain(created.token);
    view.unmount();
    await open(kind);
    expect(screen.queryByLabelText("New token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
  },
);

it.each(["kiosk", "companion"] as const)(
  "confirms %s revocation and preserves a failed creation for retry",
  async (kind) => {
    await open(kind);
    fireEvent.click(screen.getByTitle("Revoke token"));
    expect(api.revoke).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(api.revoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Revoke token"));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Revoke token",
      }),
    );
    await vi.waitFor(() =>
      expect(api.revoke).toHaveBeenCalledExactlyOnceWith({
        data: { tokenId: row.id },
      }),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    api.create.mockRejectedValue(new Error("Could not store token"));
    fireEvent.change(screen.getByPlaceholderText(/Token label/), {
      target: { value: "Retain this label" },
    });
    await vi.waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not store token",
    );
    expect(
      (screen.getByPlaceholderText(/Token label/) as HTMLInputElement).value,
    ).toBe("Retain this label");
  },
);

it.each(["timer", "overlay"] as const)(
  "creates a scoped %s browser link and removes it on dismissal",
  async (purpose) => {
    await open("kiosk");
    api.create.mockResolvedValue({ ...created, view: purpose });
    fireEvent.change(screen.getByLabelText("Token purpose"), {
      target: { value: purpose },
    });
    fireEvent.change(screen.getByPlaceholderText(/Token label/), {
      target: { value: "New display" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    const link = await screen.findByRole("link", {
      name: "Open display to check",
    });
    const url = new URL(link.getAttribute("href") ?? "");
    expect(url.pathname).toBe(`/${purpose}/org-1`);
    expect(url.searchParams.get("kioskToken")).toBe(created.token);
    if (purpose === "timer") expect(url.searchParams.get("view")).toBe("stage");
    expect(api.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        orgId: "org-1",
        label: "New display",
        view: purpose,
        expiresInDays: null,
      },
    });
    expect(screen.getByLabelText("New display link")).toHaveProperty(
      "value",
      url.href,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss token" }));
    expect(
      screen.queryByRole("link", { name: "Open display to check" }),
    ).toBeNull();
    expect(screen.queryByLabelText("New display link")).toBeNull();
  },
);
it("keeps lobby API tokens distinct from browser display links", async () => {
  await open("kiosk");
  api.create.mockResolvedValue({ ...created, view: "board" });
  fireEvent.change(screen.getByPlaceholderText(/Token label/), {
    target: { value: "Lobby integration" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  await screen.findByLabelText("New token");
  expect(screen.queryByLabelText("New display link")).toBeNull();
  expect(api.create).toHaveBeenCalledExactlyOnceWith({
    data: {
      orgId: "org-1",
      label: "Lobby integration",
      view: "board",
      expiresInDays: null,
    },
  });
});
