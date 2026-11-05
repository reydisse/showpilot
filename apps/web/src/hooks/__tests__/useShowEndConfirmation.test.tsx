import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShowEndConfirmation } from "../useShowEndConfirmation";

afterEach(cleanup);

function Controls({ scope = "show-1", stop, offline = false, date = "2026-09-06" }: { scope?: string; stop: () => void; offline?: boolean; date?: string }) {
  const { requestEndShow, endShowDialog } = useShowEndConfirmation({ orgId: "org-1", showId: scope, serviceDate: date }, stop, offline ? "Reconnect before ending this show." : undefined);
  return <><button onClick={requestEndShow}>Stop rundown</button>{endShowDialog}</>;
}

describe("ending a show", () => {
  it("keeps confirmation through an item advance and ends the current item", () => {
    const beforeAdvance = vi.fn();
    const afterAdvance = vi.fn();
    const { rerender } = render(<Controls stop={beforeAdvance} />);
    fireEvent.click(screen.getByText("Stop rundown"));
    rerender(<Controls stop={afterAdvance} date="2026-09-07" />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End show" }));
    expect(beforeAdvance).not.toHaveBeenCalled();
    expect(afterAdvance).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog visible but disables confirmation after disconnection", () => {
    const stop = vi.fn();
    const { rerender } = render(<Controls stop={stop} />);
    fireEvent.click(screen.getByText("Stop rundown"));
    rerender(<Controls stop={stop} offline />);
    expect(screen.getByText("Reconnect before ending this show.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End show" }));
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    rerender(<Controls stop={stop} />);
    fireEvent.click(screen.getByRole("button", { name: "End show" }));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves the show running until explicitly confirmed", () => {
    const stop = vi.fn();
    render(<Controls stop={stop} />);
    fireEvent.click(screen.getByText("Stop rundown"));
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep show running" }));
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Stop rundown"));
    fireEvent.click(screen.getByRole("button", { name: "End show" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels with Escape", () => {
    const stop = vi.fn();
    render(<Controls stop={stop} />);
    fireEvent.click(screen.getByText("Stop rundown"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(stop).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("discards confirmation when another show becomes current", () => {
    const stop = vi.fn();
    const { rerender } = render(<Controls stop={stop} />);
    fireEvent.click(screen.getByText("Stop rundown"));
    rerender(<Controls stop={stop} scope="show-2" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("confirmation cancelled");
    rerender(<Controls stop={stop} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });
});
