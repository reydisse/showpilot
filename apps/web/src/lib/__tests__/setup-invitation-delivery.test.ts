import { afterEach, expect, it, vi } from "vitest";
import { EmailDeliveryRejected } from "../email";
import { withSetupInvitationDelivery, sendInvitationWithSetupReceipt } from "../setup-invitation-delivery.server";
afterEach(() => vi.useRealTimers());
it("times out delivery, records uncertainty and ignores a late provider response", async () => {
  vi.useFakeTimers(); const record = vi.fn(async () => {}); let resolve: () => void = () => {};
  const send = vi.fn(() => new Promise<void>(yes => { resolve = yes; }));
  const result = withSetupInvitationDelivery({ orgId: "one", email: "one@example.test", record }, () => sendInvitationWithSetupReceipt({ orgId: "one", email: "one@example.test", invitationId: "invite-one", send })).catch(error => error);
  await vi.advanceTimersByTimeAsync(8_000); expect(await result).toBeInstanceOf(Error);
  expect(record.mock.calls).toEqual([["running", "invite-one"], ["uncertain", "invite-one"]]);
  resolve(); await Promise.resolve(); expect(record).toHaveBeenCalledTimes(2);
});
it("isolates concurrent organizations and distinguishes rejection from provider acceptance", async () => {
  const a = vi.fn(async () => {}), b = vi.fn(async () => {});
  await Promise.all([
    withSetupInvitationDelivery({ orgId: "one", email: "one@example.test", record: a }, () => sendInvitationWithSetupReceipt({ orgId: "one", email: "one@example.test", invitationId: "one", send: async () => {} })),
    withSetupInvitationDelivery({ orgId: "two", email: "two@example.test", record: b }, () => sendInvitationWithSetupReceipt({ orgId: "two", email: "two@example.test", invitationId: "two", send: async () => { throw new EmailDeliveryRejected("Rejected"); } })).catch(() => {}),
  ]);
  expect(a.mock.calls).toEqual([["running", "one"], ["accepted", "one"]]); expect(b.mock.calls).toEqual([["running", "two"], ["failed", "two"]]);
});
it("rejects a mismatched callback before sending and preserves ordinary invitations outside setup", async () => {
  const record = vi.fn(async () => {}), send = vi.fn(async () => {});
  await expect(withSetupInvitationDelivery({ orgId: "one", email: "one@example.test", record }, () => sendInvitationWithSetupReceipt({ orgId: "two", email: "one@example.test", invitationId: "one", send }))).rejects.toThrow("scope changed");
  expect(send).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
  await sendInvitationWithSetupReceipt({ orgId: "two", email: "two@example.test", invitationId: "two", send }); expect(send).toHaveBeenCalledExactlyOnceWith();
});
it("does not start email delivery after its attempt has been superseded", async () => {
  const record = vi.fn(async () => { throw new Error("This invitation attempt is no longer active."); });
  const send = vi.fn(async () => {});
  await expect(withSetupInvitationDelivery({ orgId: "one", email: "one@example.test", record }, () => sendInvitationWithSetupReceipt({ orgId: "one", email: "one@example.test", invitationId: "one", send }))).rejects.toThrow("no longer active");
  expect(send).not.toHaveBeenCalled(); expect(record).toHaveBeenCalledExactlyOnceWith("running", "one");
});
