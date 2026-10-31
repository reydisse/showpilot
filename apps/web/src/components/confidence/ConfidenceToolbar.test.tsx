import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidenceToolbar } from "./ConfidenceToolbar";
import * as output from "@/lib/confidence-output";

vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/lib/settings", () => ({ getManageableOrgSettings: vi.fn().mockResolvedValue({}) }));
vi.mock("@/lib/confidence-output", async (original) => ({
  ...await original<typeof output>(),
  getConfidenceOutputs: vi.fn(), getConfidenceOutputStatus: vi.fn(), startConfidenceOutput: vi.fn(), stopConfidenceOutput: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  vi.mocked(output.getConfidenceOutputs).mockResolvedValue({ monitors: [{ id: "display-1", name: "Stage", width: 1920, height: 1080 }], decklink: { devices: [], error: null }, active: null });
  vi.mocked(output.getConfidenceOutputStatus).mockResolvedValue({ state: "stopped", message: "Output disabled" });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("confidence quick controls", () => {
  it("opens output selection on first use, remembers the monitor, and uses real native status", async () => {
    render(<ConfidenceToolbar slug="church" />);
    fireEvent.click(screen.getByRole("button", { name: "Confidence Off" }));
    await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Stage · 1920 × 1080" });
    fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "monitor:display-1" } });
    await waitFor(() => expect(JSON.parse(localStorage.getItem("showpilot:confidence-output:church") ?? "null")).toEqual({ kind: "monitor", id: "display-1" }));
    vi.mocked(output.getConfidenceOutputStatus).mockResolvedValue({ state: "running", message: "Stage output running" });
    fireEvent.click(screen.getByRole("button", { name: "Enable output" }));
    await waitFor(() => expect(output.startConfidenceOutput).toHaveBeenCalledWith("church", { kind: "monitor", id: "display-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await screen.findByRole("button", { name: "Confidence On" });
    vi.mocked(output.getConfidenceOutputStatus).mockResolvedValue({ state: "stopped", message: "Output disabled" });
    fireEvent.click(screen.getByRole("button", { name: "Confidence On" }));
    await waitFor(() => expect(output.stopConfidenceOutput).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Confidence Off" });
  });
  it("uses the saved destination and shows a native failure rather than reporting On", async () => {
    localStorage.setItem("showpilot:confidence-output:church", JSON.stringify({ kind: "monitor", id: "display-1" }));
    vi.mocked(output.startConfidenceOutput).mockRejectedValueOnce(new Error("Display disconnected"));
    render(<ConfidenceToolbar slug="church" />);
    await waitFor(() => expect(output.getConfidenceOutputs).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Confidence Off" }));
    await screen.findByRole("button", { name: "Confidence Error" });
    expect(screen.queryByRole("button", { name: "Confidence On" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confidence Error" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Display disconnected");
  });
});
