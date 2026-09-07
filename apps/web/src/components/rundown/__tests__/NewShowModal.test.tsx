import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewShowModal } from "../NewShowModal";

describe("NewShowModal", () => {
  it("starts on the current date and proposes the next start time", () => {
    render(
      <NewShowModal
        currentDate="2026-09-07"
        currentStartTime="18:30"
        canCopyCurrent
        onCreate={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText<HTMLInputElement>("Date").value).toBe("2026-09-07");
    expect(screen.getByLabelText<HTMLInputElement>("Start time").value).toBe("19:30");
    expect(screen.getByLabelText<HTMLInputElement>("Copy the current rundown into this show").checked).toBe(true);
  });

  it("submits a separate same-day show", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <NewShowModal
        currentDate="2026-09-07"
        currentStartTime="18:00"
        canCopyCurrent
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Show name"), { target: { value: "Late service" } });
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "20:00" } });
    fireEvent.change(screen.getByLabelText("Venue or location"), { target: { value: "Main room" } });
    fireEvent.click(screen.getByRole("button", { name: "Create show" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        serviceDate: "2026-09-07",
        name: "Late service",
        startTime: "20:00",
        location: "Main room",
        copyCurrent: true,
      });
    });
  });
});
