import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SetupRundownResult } from "@/components/onboarding/SetupRundownResult";
import type { useOnboardingSeed } from "@/hooks/useOnboardingSeed";
const actions = { check: vi.fn(), save: vi.fn(), retry: vi.fn() };
const base: ReturnType<typeof useOnboardingSeed> = { ...actions, snapshot: null, busy: false, failure: null, requested: null };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("shows real pending progress and never claims the show clock is armed", () => {
  render(<SetupRundownResult seed={{ ...base, busy: true }} onDone={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toContain("Waiting for the saved result");
  expect(screen.queryByText(/armed/i)).toBeNull(); expect(screen.queryByText(/click anywhere/i)).toBeNull();
  expect(screen.queryByRole("button", { name: "Get your team in" })).toBeNull();
  for (const button of screen.getAllByRole("button")) expect(button).toHaveProperty("disabled", true);
});
it("exposes uncertainty, read checks, same-request retry, and an explicit blank choice", () => {
  const done = vi.fn(); render(<SetupRundownResult seed={{ ...base, failure: { message: "Not confirmed. It may have finished.", occurredAt: Date.now() }, requested: { orgId: "org", template: "sunday", serviceDate: "2026-11-07" } }} onDone={done} />);
  expect(screen.getByRole("alert").textContent).toContain("Last attempt:");
  fireEvent.click(screen.getByRole("button", { name: "Check saved rundown" })); expect(actions.check).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry rundown creation" })); expect(actions.retry).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Continue without adding a rundown" })); expect(actions.save).toHaveBeenCalledWith("blank"); expect(done).not.toHaveBeenCalled();
});
it("shows the actual winning template before allowing continuation", () => {
  const done = vi.fn(); render(<SetupRundownResult seed={{ ...base, requested: { orgId: "org", template: "blank", serviceDate: "2026-11-07" }, snapshot: { status: "saved", template: "sunday", serviceDate: "2026-11-07", showId: "show", items: [{ id: "one", title: "Existing title", duration: 60000 }] } }} onDone={done} />);
  expect(screen.getByRole("status").textContent).toContain("Another setup choice was saved first");
  expect(screen.getByText("Existing title")).toBeTruthy(); expect(screen.getByText(/does not start show transport/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Get your team in" })); expect(done).toHaveBeenCalledOnce(); expect(actions.save).not.toHaveBeenCalled();
});
it("allows review of legacy data without re-seeding or claiming a new rundown", () => {
  const done = vi.fn(); render(<SetupRundownResult seed={{ ...base, snapshot: { status: "review", message: "Existing partial data needs review." } }} onDone={done} />);
  expect(screen.getByRole("alert").textContent).toContain("needs review"); expect(screen.queryByRole("button", { name: "Retry rundown creation" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue with existing data" })); expect(done).toHaveBeenCalledOnce(); expect(actions.save).not.toHaveBeenCalled();
});
