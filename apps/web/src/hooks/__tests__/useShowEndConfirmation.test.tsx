import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShowEndConfirmation } from "../useShowEndConfirmation";

afterEach(cleanup);

function Controls({ scope = "show-1:item-1", stop }: { scope?: string; stop: () => void }) {
  const { requestEndShow, endShowDialog } = useShowEndConfirmation(scope);
  return <><button onClick={() => requestEndShow(stop)}>Stop rundown</button>{endShowDialog}</>;
}

describe("ending a show", () => {
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

  it("discards confirmation when another show or item becomes current", () => {
    const stop = vi.fn();
    const { rerender } = render(<Controls stop={stop} />);
    fireEvent.click(screen.getByText("Stop rundown"));
    rerender(<Controls stop={stop} scope="show-2:item-2" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<Controls stop={stop} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });
});
