import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RundownPinForm } from "@/routes/$slug/rundown-pin";
import { RundownUnlock } from "@/components/rundown/RundownUnlock";

const api = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("@/lib/rbac", () => ({
  validateRundownPin: api.validate,
  getRundownPinRequirement: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/fixture/rundown">{children}</a>
  ),
  redirect: vi.fn(),
  useNavigate: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  api.validate.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.cookie = "sp_rundown_pin_fixture=; Max-Age=0; Path=/";
});
function start(onUnlocked = vi.fn().mockResolvedValue(undefined)) {
  const view = render(
    <RundownPinForm orgId="fixture" slug="fixture" onUnlocked={onUnlocked} />,
  );
  fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1842" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock changes" }));
  return { ...view, onUnlocked };
}

it("times out, preserves the PIN and ignores a late valid reply before retrying", async () => {
  let finish = (_result: { ok: boolean }) => {};
  api.validate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { onUnlocked } = start();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000);
  });
  expect(screen.getByRole("alert").textContent).toContain("timed out");
  expect(screen.getByRole("alert").querySelector("time")).not.toBeNull();
  expect(api.validate.mock.calls[0][0].signal.aborted).toBe(true);
  expect(screen.getByLabelText<HTMLInputElement>("PIN").value).toBe("1842");
  await act(async () => {
    finish({ ok: true });
  });
  expect(onUnlocked).not.toHaveBeenCalled();
  expect(document.cookie).not.toContain("sp_rundown_pin_fixture");
  api.validate.mockResolvedValueOnce({ ok: true });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
  });
  expect(onUnlocked).toHaveBeenCalledOnce();
  expect(document.cookie).toContain("sp_rundown_pin_fixture=1842");
});

it("does not unlock after leaving the screen", async () => {
  let finish = (_result: { ok: boolean }) => {};
  api.validate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount, onUnlocked } = start();
  unmount();
  expect(api.validate.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => {
    finish({ ok: true });
  });
  expect(onUnlocked).not.toHaveBeenCalled();
  expect(document.cookie).not.toContain("sp_rundown_pin_fixture");
});

it("cancels verification immediately when the inline dialog closes", async () => {
  let finish = (_result: { ok: boolean }) => {};
  api.validate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<RundownUnlock orgId="fixture" pinAccess="locked" />);
  fireEvent.click(screen.getByRole("button", { name: "Unlock changes" }));
  fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "1842" } });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Unlock changes",
    }),
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(api.validate.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => {
    finish({ ok: true });
  });
  expect(document.cookie).not.toContain("sp_rundown_pin_fixture");
});

it("invalidates the old verification when the operator changes the PIN", async () => {
  let finish = (_result: { ok: boolean }) => {};
  api.validate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { onUnlocked } = start();
  fireEvent.change(screen.getByLabelText("PIN"), { target: { value: "0000" } });
  await act(async () => {
    finish({ ok: true });
  });
  expect(onUnlocked).not.toHaveBeenCalled();
  expect(document.cookie).not.toContain("sp_rundown_pin_fixture");
  api.validate.mockResolvedValueOnce({ ok: false });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Unlock changes" }));
  });
  expect(screen.getByRole("alert").textContent).toContain("Incorrect PIN");
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Retry verification",
    }).disabled,
  ).toBe(false);
});
