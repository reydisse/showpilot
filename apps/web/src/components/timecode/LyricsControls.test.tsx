import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LyricsControls } from "./LyricsControls";

afterEach(cleanup);
it("supports footswitch arrows while leaving editing, held keys and dialogs alone", () => {
  const change = vi.fn(async () => {});
  const view = render(<><LyricsControls enabled pending={null} error={null} onChange={change} keyboard /><input aria-label="Typing" /><div role="menu"><div role="menuitem" tabIndex={0}>Menu item</div></div></>);
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  expect(change.mock.calls).toEqual([["next"], ["previous"]]);
  fireEvent.keyDown(document.body, { key: "ArrowRight", repeat: true });
  fireEvent.keyDown(document.body, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(document.body, { key: "ArrowRight", ctrlKey: true });
  fireEvent.keyDown(screen.getByLabelText("Typing"), { key: "ArrowRight" });
  fireEvent.keyDown(screen.getByRole("menuitem"), { key: "ArrowRight" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Next section" }), { key: "ArrowRight" });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); document.body.appendChild(dialog);
  fireEvent.keyDown(document.body, { key: "ArrowRight" }); dialog.remove();
  expect(change).toHaveBeenCalledTimes(2);
  view.unmount();
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(change).toHaveBeenCalledTimes(2);
});

it("blocks buttons and shortcuts while pending or disconnected and displays the relay error", () => {
  const change = vi.fn(async () => {});
  const { rerender } = render(<LyricsControls enabled pending="next" error={null} onChange={change} keyboard />);
  fireEvent.click(screen.getByRole("button", { name: "Previous section" }));
  fireEvent.keyDown(document.body, { key: "ArrowLeft" });
  rerender(<LyricsControls enabled={false} pending={null} error="Connection lost" onChange={change} keyboard />);
  fireEvent.click(screen.getByRole("button", { name: "Clear lyrics" }));
  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe("Connection lost");
});
