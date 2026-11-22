import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CueReadNotice } from "../read-notice";
afterEach(cleanup);
it("keeps the retry label bounded, retains the failure, and returns focus after another failure", async () => {
  let reject!: (error: Error) => void;
  const onRetry = vi.fn(() => new Promise<void>((_resolve, no) => { reject = no; }));
  render(<CueReadNotice pending={false} onRetry={onRetry} />);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect((screen.getByRole("button", { name: "Trying again…" }) as HTMLButtonElement).disabled).toBe(true);
  reject(new Error("Transport detail is not user copy"));
  await screen.findByText("Still couldn't load. Check your connection.");
  expect(screen.queryByText(/Transport detail/)).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" })));
});
