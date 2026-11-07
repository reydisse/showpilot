import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConfidenceSection } from "../ConfidenceSection";
import { updateOrgSetting } from "@/lib/settings";
import { settingWriteSchema, type SettingWrite, type SettingWriteResult } from "@/lib/setting-writes";
import { DEFAULT_CONFIDENCE_LAYOUT } from "@/lib/confidence-layout";
import { SETTING_SAVE_TIMEOUT_MS } from "../useSettingAutosave";
vi.mock("@/lib/settings", () => ({ updateOrgSetting: vi.fn() }));
const requests: { input: SettingWrite; resolve: (value: SettingWriteResult) => void; reject: (error: Error) => void }[] = [];
beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  vi.mocked(updateOrgSetting).mockImplementation(options => new Promise((resolve, reject) => requests.push({ input: settingWriteSchema.parse(options && "data" in options ? options.data : undefined), resolve, reject })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });
const flush = () => act(async () => { await Promise.resolve(); });
function acknowledge(index: number, outcome: "applied" | "conflict" = "applied", currentValue = requests[index].input.value) {
  const { input, resolve } = requests[index]; resolve({ key: input.key, requestId: input.requestId, outcome, currentValue });
}
function setup() {
  const onApplied = vi.fn();
  const rendered = render(<ConfidenceSection orgId="org-one" slug="org-one" initialValue={undefined} onApplied={onApplied} showOutputs={false} />);
  return { ...rendered, onApplied };
}
it("keeps drafts local and marks the layout applied only after acknowledgement", async () => {
  const { onApplied } = setup();
  fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
  expect(updateOrgSetting).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" }));
  await flush();
  expect(screen.getByRole("button", { name: "Applying…" }).hasAttribute("disabled")).toBe(true);
  expect(onApplied).not.toHaveBeenCalled();
  expect(requests[0].input.expectedValue).toBeNull();
  await act(async () => acknowledge(0));
  expect(onApplied).toHaveBeenCalledWith(requests[0].input.value);
  expect(JSON.parse(requests[0].input.value).lyrics.showNext).toBe(false);
  expect(screen.getByRole("button", { name: "Apply to screens" }).hasAttribute("disabled")).toBe(true);
});
it("retries the same apply after failure and preserves newer preview edits", async () => {
  const { onApplied } = setup();
  fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" }));
  await flush(); await act(async () => requests[0].reject(new Error("offline")));
  expect(onApplied).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Current text color"), { target: { value: "#123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry Confidence layout" }));
  await flush(); expect(requests[1].input).toEqual(requests[0].input);
  await act(async () => acknowledge(1));
  expect(onApplied).toHaveBeenCalledWith(requests[0].input.value);
  expect(screen.getByRole("button", { name: "Apply to screens" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" })); await flush();
  expect(JSON.parse(requests[2].input.value).lyrics.color).toBe("#123456");
  expect(requests[2].input.expectedValue).toBe(requests[0].input.value);
  await act(async () => acknowledge(2));
});
it("bounds a stalled apply and ignores its late acknowledgement", async () => {
  vi.useFakeTimers(); const { onApplied } = setup();
  fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" })); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(SETTING_SAVE_TIMEOUT_MS); });
  expect(screen.getByRole("button", { name: "Retry Confidence layout" })).toBeTruthy();
  await act(async () => acknowledge(0)); expect(onApplied).not.toHaveBeenCalled();
});
it("offers explicit conflict review and loads the saved layout without another write", async () => {
  const { onApplied } = setup();
  fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" })); await flush();
  const saved = JSON.stringify({ ...DEFAULT_CONFIDENCE_LAYOUT, lyrics: { ...DEFAULT_CONFIDENCE_LAYOUT.lyrics, color: "#123456" } });
  await act(async () => acknowledge(0, "conflict", saved));
  fireEvent.click(screen.getByRole("button", { name: "Use saved value" }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith(saved));
  expect(requests).toHaveLength(1);
  expect(screen.getByLabelText("Current text color").getAttribute("value")).toBe("#123456");
});
it("does not acknowledge an apply after its editor unmounts", async () => {
  const { onApplied, unmount } = setup();
  fireEvent.click(screen.getByLabelText("Show upcoming lyric"));
  fireEvent.click(screen.getByRole("button", { name: "Apply to screens" })); await flush();
  unmount(); await act(async () => acknowledge(0)); expect(onApplied).not.toHaveBeenCalled();
});
