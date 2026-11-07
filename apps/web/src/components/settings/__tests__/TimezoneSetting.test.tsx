import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimezoneSetting } from "../TimezoneSetting";

afterEach(cleanup);
it("searches the supported catalog without changing the saved timezone", () => {
  const onChange = vi.fn();
  render(<TimezoneSetting value="Europe/London" onChange={onChange} />);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "toronto" },
  });
  expect(screen.getByRole("option", { name: "America/Toronto" })).toBeTruthy();
  expect(
    screen.getByRole("option", { name: "Europe/London (current selection)" }),
  ).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Timezone" }), {
    target: { value: "America/Toronto" },
  });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("America/Toronto");
});
it("preserves an existing alias and a failed save's restored value through searches", () => {
  const onChange = vi.fn();
  const { rerender } = render(
    <TimezoneSetting value="US/Eastern" onChange={onChange} />,
  );
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "no such city" },
  });
  expect(screen.getByRole("status").textContent).toContain(
    "No matching timezones",
  );
  expect(
    screen.getByRole("option", { name: "US/Eastern (current selection)" }),
  ).toBeTruthy();
  rerender(<TimezoneSetting value="Asia/Kathmandu" onChange={onChange} />);
  expect(
    screen.getByRole("option", { name: "Asia/Kathmandu (current selection)" }),
  ).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
});
it("shows an unset timezone honestly and offers UTC separately from London", () => {
  render(<TimezoneSetting value="" onChange={vi.fn()} />);
  expect(
    screen.getByRole("option", { name: "Not configured. Choose a timezone" }),
  ).toBeTruthy();
  expect(screen.getByRole("option", { name: "UTC" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Europe/London" })).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "new york" },
  });
  expect(screen.getByRole("option", { name: "America/New York" })).toBeTruthy();
});
