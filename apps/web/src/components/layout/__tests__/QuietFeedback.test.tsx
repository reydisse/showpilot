import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuietActivity } from "@/components/ui/QuietActivity";
import { ReadFailureNotice } from "../ReadFailureNotice";
import { NotificationCountSummary } from "../NotificationCountSummary";
import { plainFailure } from "@showpilot/shared/ui-feedback";
afterEach(cleanup);
it("provides one accessible progress indicator without visible status words", () => {
  render(<QuietActivity label="Waiting for the saved result" />);
  expect(screen.getByRole("progressbar", { name: "Waiting for the saved result" })).toBeTruthy();
  expect(screen.getByText("Waiting for the saved result").className).toBe("sr-only");
});
it.each(["loading", "ready"] as const)("never repeats the bell count or its poll time in the %s panel", kind => {
  const { container } = render(<NotificationCountSummary state={{ kind, snapshot: { unread: 8, confirmedAt: 123000 } }} onRetry={vi.fn()} />);
  expect(container.textContent).toBe(""); expect(container.querySelector("time")).toBeNull();
});
it("surfaces a real read failure once, in plain words, and retains its retry", () => {
  const retry = vi.fn(); render(<ReadFailureNotice error={{ message: "Relay revision confirmation failed. Request 123 timed out.", occurredAt: 123000 }} refreshing={false} retry={retry} label="Retry dashboard" />);
  expect(screen.getAllByRole("alert")).toHaveLength(1); expect(screen.getByText("This view could not be updated.")).toBeTruthy(); expect(document.querySelector("time")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Retry dashboard" })); expect(retry).toHaveBeenCalledOnce();
});
it("retains useful validation and sign-in failures without leaking protocol detail", () => {
  expect(plainFailure("Enter a valid email address.")).toBe("Enter a valid email address.");
  expect(plainFailure("Unauthorized")).toBe("Please sign in again."); expect(plainFailure("JSON could not be parsed: secret internal detail")).toBe("This action needs attention.");
});

it.each(["SQLITE_CONSTRAINT_UNIQUE: crew_member.memberId", "D1_ERROR: internal database error", "PrismaClientKnownRequestError: table details", "WebSocket closed: internal endpoint", "HTTP 503", "Cannot read properties of undefined", "internalHandler is not a function"])("keeps diagnostic failures out of the interface: %s", message => {
  expect(plainFailure(message, "This view could not be opened.")).toBe("This view could not be opened.");
});
