import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FullscreenExitButton } from "../FullscreenExitButton";

const state = vi.hoisted(() => ({ fullscreen: true, toggleFullscreen: vi.fn() }));
vi.mock("../SidebarContext", () => ({ useSidebar: () => state }));
afterEach(() => { cleanup(); state.fullscreen = true; vi.clearAllMocks(); });

it("keeps the fullscreen exit visible without hover or focus and exits on click", () => {
  render(<FullscreenExitButton />);
  const button = screen.getByRole("button", { name: "Exit fullscreen" });
  expect(button.className.split(/\s+/)).toContain("opacity-100");
  for (const token of ["[@media(hover:hover)]:opacity-40", "[@media(hover:hover)]:hover:opacity-100", "focus:opacity-100", "focus-visible:opacity-100", "[@media(hover:hover)]:focus:opacity-100", "[@media(hover:hover)]:focus-visible:opacity-100"]) {
    expect(button.className.split(/\s+/)).toContain(token);
  }
  expect(button.className).not.toMatch(/(?:^|[\s:])opacity-0(?:\s|$)/);
  fireEvent.click(button);
  expect(state.toggleFullscreen).toHaveBeenCalledOnce();
});

it("renders only in fullscreen", () => {
  state.fullscreen = false;
  render(<FullscreenExitButton />);
  expect(screen.queryByRole("button", { name: "Exit fullscreen" })).toBeNull();
});
