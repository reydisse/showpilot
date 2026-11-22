// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DateTimePicker } from "../date-time-picker";
afterEach(cleanup);
it("selects a calendar date and disables dates before the minimum", () => {
  const change = vi.fn();
  render(<DateTimePicker kind="date" value="2026-11-21" min="2026-11-21" onValueChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "Choose date" }));
  expect((screen.getByRole("button", { name: "2026-11-20" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "2026-11-22" }));
  expect(change).toHaveBeenCalledWith("2026-11-22");
});
it("selects times, allows exact minute entry, and clears optional times", () => {
  const change = vi.fn();
  render(<DateTimePicker kind="time" aria-label="Start" value="09:00" onValueChange={change} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Start" }), { target: { value: "09:07" } });
  expect(change).toHaveBeenCalledWith("09:07");
  fireEvent.click(screen.getByRole("button", { name: "Choose Start" }));
  fireEvent.click(screen.getByRole("button", { name: "10:15" }));
  expect(change).toHaveBeenCalledWith("10:15");
  fireEvent.click(screen.getByRole("button", { name: "Choose Start" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(change).toHaveBeenCalledWith("");
});
