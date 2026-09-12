import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes } from "react";
import { LiveRundownBar } from "../LiveRundownBar";

const mocks = vi.hoisted(() => ({
  getTarget: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("@/lib/rundown", () => ({
  getActiveRundownTarget: mocks.getTarget,
}));

vi.mock("@/hooks/useRundownSync", () => ({
  useRundownSync: () => ({
    items: [{ id: "item-1", title: "Welcome", duration: 300_000 }],
    timer: {
      playback: "pause",
      currentItemId: "item-1",
      elapsed: 60_000,
      startedAt: null,
      mode: "count-down",
    },
    serviceName: "Sunday Morning",
    connected: true,
    hydrated: true,
    sendCommand: mocks.sendCommand,
  }),
}));

describe("LiveRundownBar", () => {
  beforeEach(() => {
    mocks.getTarget.mockReset();
    mocks.sendCommand.mockReset();
    mocks.getTarget.mockResolvedValue({ serviceDate: "2026-09-13", showId: "show-1" });
  });

  it("keeps the active item and controls visible outside the rundown route", async () => {
    render(<LiveRundownBar orgId="org-1" slug="faithfire" canControl />);

    expect(await screen.findByText("Welcome")).not.toBeNull();
    expect(screen.getByText("4:00")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume rundown" }));
    expect(mocks.sendCommand).toHaveBeenCalledWith("timer-resume");
  });
});
