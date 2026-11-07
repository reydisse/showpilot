import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidenceToolbar } from "./ConfidenceToolbar";
import * as output from "@/lib/confidence-output";
import { getManageableOrgSettings, updateOrgSetting } from "@/lib/settings";
import { settingWriteSchema } from "@/lib/setting-writes";
import { CONFIDENCE_LAYOUT_KEY, DEFAULT_CONFIDENCE_LAYOUT } from "@/lib/confidence-layout";

vi.mock("@/lib/desktop-runtime", () => ({ isDesktopRuntime: () => true }));
vi.mock("@/lib/settings", () => ({ getManageableOrgSettings: vi.fn().mockResolvedValue({}), updateOrgSetting: vi.fn() }));
vi.mock("@/lib/confidence-output", async (original) => ({
  ...await original<typeof output>(),
  getConfidenceOutputs: vi.fn(), getConfidenceOutputStatus: vi.fn(), startConfidenceOutput: vi.fn(), stopConfidenceOutput: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.mocked(getManageableOrgSettings).mockResolvedValue({});
  vi.mocked(updateOrgSetting).mockImplementation(async options => { const data = settingWriteSchema.parse(options && "data" in options ? options.data : undefined); return { requestId: data.requestId, key: data.key, outcome: "applied", currentValue: data.value }; });
  vi.mocked(output.getConfidenceOutputs).mockResolvedValue({ monitors: [{ id: "display-1", name: "Stage", width: 1920, height: 1080 }], decklink: { devices: [], error: null }, active: null });
  vi.mocked(output.getConfidenceOutputStatus).mockResolvedValue({ state: "stopped", message: "Output disabled" });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

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
    fireEvent.click(screen.getByRole("button", { name: "Confidence output and appearance" }));
    await screen.findByRole("dialog");
    expect(output.stopConfidenceOutput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
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


it("keeps a dirty confidence preview on Cancel and discards it only after confirming close", async () => {
  render(<ConfidenceToolbar slug="church" orgId="org-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Confidence output and appearance" }));
  fireEvent.click(await screen.findByLabelText("Show upcoming lyric"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(await screen.findByText("Close confidence settings?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByText("Close confidence settings?")).toBeNull());
  expect(screen.getByLabelText("Show upcoming lyric")).toHaveProperty("checked", false);
  expect(updateOrgSetting).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(await screen.findByRole("button", { name: "Close settings" }));
  await waitFor(() => expect(screen.queryByLabelText("Show upcoming lyric")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Confidence output and appearance" }));
  expect(await screen.findByLabelText("Show upcoming lyric")).toHaveProperty("checked", true);
});

it("removes the old organization's preview while the new organization's layout loads", async () => {
  let resolveNext: (settings: Record<string, string>) => void = () => {};
  const { rerender } = render(<ConfidenceToolbar slug="church-a" orgId="org-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Confidence output and appearance" }));
  fireEvent.click(await screen.findByLabelText("Show upcoming lyric"));
  vi.mocked(getManageableOrgSettings).mockReturnValueOnce(new Promise(resolve => { resolveNext = resolve; }));
  rerender(<ConfidenceToolbar slug="church-b" orgId="org-b" />);
  expect(screen.queryByLabelText("Show upcoming lyric")).toBeNull();
  const layout = { ...DEFAULT_CONFIDENCE_LAYOUT, lyrics: { ...DEFAULT_CONFIDENCE_LAYOUT.lyrics, color: "#123456" } };
  await act(async () => resolveNext({ [CONFIDENCE_LAYOUT_KEY]: JSON.stringify(layout) }));
  expect(await screen.findByLabelText("Show upcoming lyric")).toHaveProperty("checked", true);
  expect(screen.getByLabelText("Current text color")).toHaveProperty("value", "#123456");
  fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" }));
  await waitFor(() => expect(updateOrgSetting).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ orgId: "org-b", expectedValue: JSON.stringify(layout) }) })));
});
