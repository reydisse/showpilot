import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResetRundownDialog } from "./ResetRundownDialog";
import { DeleteSavedTemplateButton } from "./DeleteSavedTemplateButton";

afterEach(cleanup);

it("requires reset confirmation and blocks a timer that starts while the dialog is open", () => {
  const onReset = vi.fn();
  const props = { open: true, onOpenChange: vi.fn(), onReset };
  const view = render(<ResetRundownDialog {...props} playing={false} />);
  expect(onReset).not.toHaveBeenCalled();
  view.rerender(<ResetRundownDialog {...props} playing />);
  fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
  expect(onReset).not.toHaveBeenCalled();
  expect(screen.getByText(/Pause or stop the timer/)).toBeTruthy();
  view.rerender(<ResetRundownDialog {...props} playing={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Reset timer" }));
  expect(onReset).toHaveBeenCalledTimes(1);
});

it("does not delete a template before confirmation and exposes a failed deletion", async () => {
  const onDelete = vi.fn().mockRejectedValueOnce(new Error("Template could not be deleted")).mockResolvedValueOnce(undefined);
  render(<DeleteSavedTemplateButton name="Sunday" onDelete={onDelete} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete Sunday template" }));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete Sunday template" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete template" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Template could not be deleted");
  fireEvent.click(screen.getByRole("button", { name: "Delete Sunday template" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete template" }));
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  expect(onDelete).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
