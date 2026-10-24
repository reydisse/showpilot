import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidenceSection } from "../ConfidenceSection";
import { updateOrgSetting } from "@/lib/settings";

vi.mock("@/lib/settings", () => ({ updateOrgSetting: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("confidence layout apply", () => {
  it("keeps drafts local and updates the saved value only after the server accepts it", async () => {
    let resolve: (
      value: Awaited<ReturnType<typeof updateOrgSetting>>,
    ) => void = () => {};
    vi.mocked(updateOrgSetting).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const onApplied = vi.fn();
    render(
      <ConfidenceSection
        orgId="org-one"
        slug="org-one"
        initialValue=""
        onApplied={onApplied}
      />,
    );
    fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
    expect(updateOrgSetting).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply to screens" }));
    expect(
      screen
        .getByRole("button", { name: "Applying…" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(onApplied).not.toHaveBeenCalled();
    resolve({
      id: "setting-one",
      key: "default-confidence-layout",
      value: "saved",
      orgId: "org-one",
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onApplied.mock.calls[0][0]).lyrics.showNext).toBe(false);
    expect(updateOrgSetting).toHaveBeenCalledWith({
      data: {
        orgId: "org-one",
        key: "default-confidence-layout",
        value: onApplied.mock.calls[0][0],
      },
    });
    expect(
      screen
        .getByRole("button", { name: "Apply to screens" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("retains the draft after a failed apply and makes retry available", async () => {
    vi.mocked(updateOrgSetting).mockRejectedValue(new Error("offline"));
    const onApplied = vi.fn();
    render(
      <ConfidenceSection
        orgId="org-one"
        slug="org-one"
        initialValue=""
        onApplied={onApplied}
      />,
    );
    fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
    fireEvent.click(screen.getByRole("button", { name: "Apply to screens" }));
    await screen.findByRole("alert");
    expect(onApplied).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Apply to screens" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(document.querySelector("[data-confidence-next]")).toBeNull();
  });
});
