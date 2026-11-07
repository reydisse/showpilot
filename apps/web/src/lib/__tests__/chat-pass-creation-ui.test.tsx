import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatShareDialog } from "@/components/chat/ChatShareDialog";
import type { CreatedChatPass } from "../chat-pass-creation";
const api = vi.hoisted(() => ({ crew: vi.fn(), planning: vi.fn() }));
vi.mock("@/lib/crew-chat-pass", () => ({ createCrewChatPass: api.crew, createPlanningChatPass: api.planning }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });
function pass(notifications: CreatedChatPass["notifications"] = { status: "not-needed" }): CreatedChatPass {
  return { token: "chat_header.body.signature", orgSlug: "org", expiresAt: Date.now() + 3600_000, targetCount: 1, notifications };
}
const members = [{ userId: "person", name: "Camera fixture", role: "member" }];
function Harness({ planning = false, revokedToken = null }: { planning?: boolean; revokedToken?: string | null }) {
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Open invite</button><ChatShareDialog orgId="org" scope={planning ? "planning-chat" : "crew-chat"} members={members} open={open} onOpenChange={setOpen} revokedToken={revokedToken} /></>;
}
async function click(name: string) { await act(async () => fireEvent.click(screen.getByRole("button", { name }))); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
it("shows a creation error, preserves choices and reuses the exact request on retry", async () => {
  api.crew.mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValueOnce(pass());
  render(<Harness />);
  fireEvent.click(screen.getByRole("radio", { name: "24h" }));
  await click("Create crew pass");
  expect(screen.getByRole("alert").textContent).toContain("Network unavailable");
  expect(screen.getByRole("radio", { name: "24h" })).toHaveProperty("checked", true);
  expect(screen.getByRole("radio", { name: "2h" }).matches(":disabled")).toBe(true);
  await click("Retry link");
  expect(api.crew.mock.calls[1][0].data).toEqual(api.crew.mock.calls[0][0].data);
  expect(api.crew.mock.calls[0][0].data).toMatchObject({ orgId: "org", hours: 24, requestId: expect.any(String) });
  expect(screen.getByRole("status").textContent).toContain("Crew pass is ready");
});
it("times out a hung creation, aborts and ignores a late success", async () => {
  vi.useFakeTimers(); const pending = deferred<CreatedChatPass>(); api.crew.mockReturnValue(pending.promise);
  render(<Harness />); await click("Create crew pass");
  await act(async () => vi.advanceTimersByTimeAsync(10_001));
  expect(api.crew.mock.calls[0][0].signal.aborted).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
  await act(async () => pending.resolve(pass()));
  expect(screen.queryByText("Crew pass is ready")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry link" })).toBeTruthy();
});
it("closing cancels waiting, reopening retains recovery and duplicate clicks send once", async () => {
  const pending = deferred<CreatedChatPass>(); api.crew.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(pass());
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Create crew pass" });
  await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  expect(api.crew).toHaveBeenCalledTimes(1);
  await click("Close"); expect(api.crew.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => pending.resolve(pass()));
  await click("Open invite");
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
  await click("Retry link");
  expect(api.crew.mock.calls[1][0].data).toEqual(api.crew.mock.calls[0][0].data);
  await click("Close"); await click("Open invite");
  expect(screen.getByRole("status").textContent).toContain("Crew pass is ready");
});
it("only an explicit new creation uses a different request identity", async () => {
  api.crew.mockResolvedValue(pass()); render(<Harness />);
  await click("Create crew pass"); await click("Start a new link");
  fireEvent.click(screen.getByRole("radio", { name: "2h" }));
  await click("Create crew pass");
  expect(api.crew.mock.calls[1][0].data.requestId).not.toBe(api.crew.mock.calls[0][0].data.requestId);
  expect(api.crew.mock.calls[1][0].data.hours).toBe(2);
});
it("keeps a usable Planning link when notifications fail and retries the same selection", async () => {
  const saved = pass({ status: "pending", missing: 1 });
  api.planning.mockResolvedValueOnce(saved).mockResolvedValueOnce({ ...saved, notifications: { status: "saved", recipients: 1 } });
  render(<Harness planning />);
  await click("Create Planning link");
  expect(screen.getByRole("alert").textContent).toContain("Choose between 1 and 50");
  expect(api.planning).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Camera fixture member" }));
  await click("Create Planning link");
  const field = screen.getByLabelText("Planning invite link");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("Invite field missing");
  const link = field.value;
  expect(screen.getByRole("alert").textContent).toContain("1 inbox notification");
  await click("Retry notifications");
  expect(api.planning.mock.calls[1][0].data).toEqual(api.planning.mock.calls[0][0].data);
  expect(screen.getByLabelText("Planning invite link")).toHaveProperty("value", link);
  expect(screen.getByText(/Inbox notifications saved for 1/)).toBeTruthy();
});
it("reports clipboard denial, exposes the link and allows copy retry", async () => {
  api.crew.mockResolvedValue(pass());
  const writeText = vi.fn().mockRejectedValueOnce(new Error("Denied")).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<Harness />); await click("Create crew pass"); await click("Copy link");
  expect(screen.getByRole("alert").textContent).toContain("copy it manually");
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  const field = screen.getByLabelText("Crew join link");
  expect(field).toHaveProperty("readOnly", true);
  await click("Retry copy");
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
});
it("keeps a long Planning link shareable when it exceeds QR capacity", async () => {
  const saved = { ...pass(), token: `planning_chat_${"a".repeat(3200)}`, targetCount: 50 };
  api.planning.mockResolvedValue(saved);
  render(<Harness planning />);
  fireEvent.click(screen.getByRole("checkbox", { name: "Camera fixture member" }));
  await click("Create Planning link");
  expect(screen.getByLabelText("Planning invite link")).toHaveProperty("value", `${window.location.origin}/join/chat/planning/${saved.token}`);
  expect(screen.getByText("This link is too long for a QR code. Copy the link to share it.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
});
it("renders the real QR encoder at the supported byte budget", async () => {
  const prefix = `${window.location.origin}/join/chat/`;
  api.crew.mockResolvedValue({ ...pass(), token: "a".repeat(2000 - prefix.length) });
  render(<Harness />); await click("Create crew pass");
  expect(screen.getByRole("img", { name: "Chat join QR code" })).toBeTruthy();
});
it("expires a displayed grant and stops displaying a revoked signature alias", async () => {
  vi.useFakeTimers(); api.crew.mockResolvedValueOnce({ ...pass(), expiresAt: Date.now() + 1000 });
  const view = render(<Harness />); await click("Create crew pass");
  await act(async () => vi.advanceTimersByTimeAsync(1001));
  expect(screen.queryByLabelText("Crew join link")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("expired");
  api.crew.mockResolvedValueOnce(pass()); await click("Start a new link"); await click("Create crew pass");
  view.rerender(<Harness revokedToken="chat_header.body.equivalentSignature" />);
  expect(screen.queryByLabelText("Crew join link")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("disabled");
});
it("Escape closes the shared dialog and unmount aborts pending work", async () => {
  const pending = deferred<CreatedChatPass>(); api.crew.mockReturnValue(pending.promise);
  const view = render(<Harness />);
  expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await click("Open invite"); await click("Create crew pass");
  view.unmount(); expect(api.crew.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => pending.resolve(pass()));
});
