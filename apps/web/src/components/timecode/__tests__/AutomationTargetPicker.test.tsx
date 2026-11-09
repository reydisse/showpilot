import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationTargetPicker, type AutomationTargetOption } from "../AutomationTargetPicker";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("times out a stalled request, offers Retry and ignores its late result", async () => {
  vi.useFakeTimers();
  let finish: (items: AutomationTargetOption[]) => void = () => {};
  const loadOptions = () => new Promise<AutomationTargetOption[]>(resolve => { finish = resolve; });
  render(<AutomationTargetPicker kind="lighting-blackout" loadOptions={loadOptions} selection={null} onSelect={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toBe("Loading lighting devices…");
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(screen.getByRole("alert").textContent).toContain("timed out");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry loading targets" })).toHaveProperty("disabled", false);
  await act(async () => finish([{ id: "late", label: "Late target" }]));
  expect(screen.queryByRole("option", { name: /Late target/ })).toBeNull();
  expect(screen.getByLabelText("Lighting device")).toHaveProperty("disabled", true);
});
