import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InternalGeneratorStart } from "./InternalGeneratorStart";
import type { TimecodeState } from "@/types/timecode";

afterEach(cleanup);
const clock: TimecodeState = {
  showId: "show",
  format: { frameRate: 30, dropFrame: "ndf" },
  totalFrames: 300,
  display: "00:00:10:00",
  timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 },
  source: "internal-freerun",
  serverTime: 1,
  running: false,
  triggersEnabled: true,
  lyrics: null,
};
function custom(text: string) {
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Start at a specific timecode" }),
  );
  fireEvent.change(screen.getByLabelText("Internal start position"), {
    target: { value: text },
  });
}

it("resumes the held clock by default and confirms an explicit start position", () => {
  const start = vi.fn();
  render(
    <InternalGeneratorStart
      clock={clock}
      connected
      pending={null}
      onStart={start}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Resume Internal Generator" }),
  );
  expect(start).toHaveBeenCalledExactlyOnceWith();
  start.mockClear();
  custom("00:01:00:02");
  fireEvent.click(screen.getByRole("button", { name: "Start at 00:01:00:02" }));
  expect(start).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain(
    "Fired cues stay fired",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByLabelText("Internal start position")).toHaveProperty(
    "value",
    "00:01:00:02",
  );
  fireEvent.click(screen.getByRole("button", { name: "Start at 00:01:00:02" }));
  fireEvent.click(screen.getByRole("button", { name: "Start from position" }));
  expect(start).toHaveBeenCalledExactlyOnceWith({
    timecode: { hours: 0, minutes: 1, seconds: 0, frames: 2 },
    expectedShowId: "show",
    expectedFrame: 300,
    expectedFormat: clock.format,
    confirmed: true,
  });
});

it.each(["frame", "format", "show", "running", "offline", "pending"])(
  "blocks a stale start confirmation after %s changes",
  (change) => {
    const start = vi.fn();
    const view = render(
      <InternalGeneratorStart
        clock={clock}
        connected
        pending={null}
        onStart={start}
      />,
    );
    custom("00:00:20:00");
    fireEvent.click(
      screen.getByRole("button", { name: "Start at 00:00:20:00" }),
    );
    const changed = {
      ...clock,
      ...(change === "frame"
        ? { totalFrames: 301 }
        : change === "format"
          ? { format: { frameRate: 25, dropFrame: "ndf" } as const }
          : change === "show"
            ? { showId: "another" }
            : change === "running"
              ? { running: true }
              : {}),
    };
    view.rerender(
      <InternalGeneratorStart
        clock={changed}
        connected={change !== "offline"}
        pending={change === "pending" ? "starting" : null}
        onStart={start}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Start from position" }),
    ).toHaveProperty("disabled", true);
    expect(start).not.toHaveBeenCalled();
  },
);

it("validates timecode and rejects dropped labels for 29.97 DF", () => {
  const start = vi.fn();
  render(
    <InternalGeneratorStart
      clock={{ ...clock, format: { frameRate: 29.97, dropFrame: "df" } }}
      connected
      pending={null}
      onStart={start}
    />,
  );
  custom("00:01:00;00");
  for (const text of [
    "",
    "garbage",
    "24:00:00:00",
    "00:00:00:30",
    "00:01:00;01",
  ]) {
    fireEvent.change(screen.getByLabelText("Internal start position"), {
      target: { value: text },
    });
    expect(
      screen.getByRole("button", { name: "Start at timecode" }),
    ).toHaveProperty("disabled", true);
    expect(screen.getByRole("alert")).toBeTruthy();
  }
  fireEvent.change(screen.getByLabelText("Internal start position"), {
    target: { value: "00:01:00;02" },
  });
  expect(
    screen.getByRole("button", { name: "Start at 00:01:00;02" }),
  ).toHaveProperty("disabled", false);
  expect(start).not.toHaveBeenCalled();
});
