import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatPassRevocation, chatTokenFromLink } from "@/components/chat/ChatPassRevocation";
const api = vi.hoisted(() => ({ revoke: vi.fn() }));
vi.mock("@/lib/crew-chat-pass", () => ({ revokeChatPass: api.revoke }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const token = "chat_fixture.signature.bytes";
const link = `https://app.showpilot.tech/join/chat/${token}`;
async function open() {
  const onRevoked = vi.fn();
  render(<ChatPassRevocation orgId="org" onRevoked={onRevoked} />);
  fireEvent.click(screen.getByRole("button", { name: "Disable a chat link" }));
  fireEvent.change(screen.getByLabelText("Chat invite link"), { target: { value: link } });
  return onRevoked;
}
async function confirm(label = "Review disable") {
  fireEvent.click(screen.getByRole("button", { name: label }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Disable link" })));
}
it("requires confirmation and retains the link when cancelled", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Review disable" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.revoke).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Chat invite link")).toHaveProperty("value", link);
});
it("retains an unconfirmed link and retries the same command after visible failure", async () => {
  const onRevoked = await open();
  api.revoke.mockRejectedValueOnce(new Error("Connection failed"));
  await confirm();
  expect(screen.getByRole("alert").textContent).toContain("Connection failed");
  expect(screen.getByLabelText("Chat invite link")).toHaveProperty("value", link);
  api.revoke.mockResolvedValueOnce({ status: "revoked", disconnected: true });
  await confirm("Retry disable");
  expect(api.revoke.mock.calls.map(call => call[0].data)).toEqual([{ orgId: "org", token }, { orgId: "org", token }]);
  expect(screen.getByRole("status").textContent).toContain("This link is disabled");
  expect(onRevoked).toHaveBeenCalledWith(token);
});
it("bounds a stalled request and ignores its late success", async () => {
  vi.useFakeTimers(); const onRevoked = await open();
  let finish!: (value: unknown) => void;
  api.revoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await confirm();
  await act(async () => vi.advanceTimersByTimeAsync(10001));
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
  expect(api.revoke.mock.calls[0][0].signal.aborted).toBe(true);
  await act(async () => finish({ status: "revoked", disconnected: true }));
  expect(onRevoked).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Retry disable" })).toBeTruthy();
});
it("does not claim guests disconnected when the relay acknowledgement failed", async () => {
  await open(); api.revoke.mockResolvedValue({ status: "revoked", disconnected: false });
  await confirm();
  expect(screen.getByRole("status").textContent).toContain("up to a minute");
  expect(screen.getByRole("button", { name: "Retry disconnection" })).toBeTruthy();
});
it("ignores a pending reply after closing and preserves an explicit recovery action", async () => {
  const onRevoked = await open(); let finish!: (value: unknown) => void;
  api.revoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await confirm(); fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await act(async () => finish({ status: "revoked", disconnected: true }));
  expect(onRevoked).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Disable a chat link" }));
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
  expect(screen.getByLabelText("Chat invite link")).toHaveProperty("value", link);
});
it("parses invite paths without fetching a pasted address or accepting unrelated routes", () => {
  expect(chatTokenFromLink(link)).toBe(token);
  expect(chatTokenFromLink("https://app.showpilot.tech/join/chat/planning/planning_chat_one.two.three")).toBe("planning_chat_one.two.three");
  for (const value of ["https://app.showpilot.tech/org/chat", "javascript:alert(1)", "not a link"]) expect(() => chatTokenFromLink(value)).toThrow("complete ShowPilot");
});
