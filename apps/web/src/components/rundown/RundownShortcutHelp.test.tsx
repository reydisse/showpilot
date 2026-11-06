import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RundownShortcutBanner } from "./RundownShortcutHelp";

afterEach(() => { cleanup(); localStorage.clear(); });

it("shows the shortcut list on first open and remembers dismissal", () => {
  const first = render(<RundownShortcutBanner />);
  expect(screen.getByRole("region", { name: "Rundown keyboard shortcuts" })).toBeTruthy();
  expect(screen.getByText("Shift + Space")).toBeTruthy();
  expect(screen.getByText("Shift + N")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss shortcuts" }));
  expect(screen.queryByRole("region")).toBeNull();
  first.unmount();
  render(<RundownShortcutBanner />);
  expect(screen.queryByRole("region")).toBeNull();
});
