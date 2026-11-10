import { afterEach, expect, it } from "vitest";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { invitationCommandSchema, invitationMutationOptions, invitationStatusText } from "../../../../mobile/src/lib/invitation-recovery.ts";
import { createLocalRequestUuid } from "../../../../mobile/src/lib/request-id.ts";

afterEach(() => onlineManager.setOnline(true));
it("retains an exact failed native invitation in the real mutation cache for a reopened screen", async () => {
  const client = new QueryClient();
  const key = ["team-invitation-command", "org", "user"];
  const command = { kind: "invite", orgId: "org", email: "test@example.test", role: "member", requestId: createLocalRequestUuid() };
  expect(invitationCommandSchema.parse(command)).toEqual(command);
  const requests = []; let confirmed = 0;
  const options = invitationMutationOptions({ key, client, execute: async input => {
    requests.push(input);
    if (requests.length === 1) throw new Error("Reply lost");
    return { id: "saved-invitation" };
  }, confirmed: () => { confirmed++; } });
  try {
    const initial = client.getMutationCache().build(client, options);
    await expect(initial.execute(command)).rejects.toThrow("Reply lost");
    const reopened = client.getMutationCache().findAll({ mutationKey: key, exact: true }).at(-1);
    expect(reopened.state.status).toBe("error");
    const retained = invitationCommandSchema.parse(reopened.state.variables);
    await client.getMutationCache().build(client, options).execute(retained);
    expect(requests).toEqual([command, command]);
    expect(confirmed).toBe(1);
    const remaining = client.getMutationCache().findAll({ mutationKey: key, exact: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].state.status).toBe("success");
    expect(client.getMutationCache().findAll({ mutationKey: ["team-invitation-command", "org", "other-user"], exact: true })).toHaveLength(0);
  } finally { client.clear(); }
});
it("does not pause the native invitation indefinitely when the device is offline", async () => {
  const client = new QueryClient(); onlineManager.setOnline(false);
  const command = { kind: "retry", orgId: "org", invitationId: "invitation", deliveryId: "delivery" };
  const options = invitationMutationOptions({ key: ["offline-invitation"], client, execute: async () => { throw new Error("Network unavailable"); }, confirmed: () => { throw new Error("Must not confirm"); } });
  try {
    const mutation = client.getMutationCache().build(client, options);
    await expect(mutation.execute(command)).rejects.toThrow("Network unavailable");
    expect(mutation.state.isPaused).toBe(false);
    expect(mutation.state.status).toBe("error");
    expect(mutation.state.variables).toEqual(command);
  } finally { client.clear(); }
});

it("never describes an expired or canceled native invitation as waiting for someone to join", () => {
  const invitation = { status: "pending", expiresAt: "2000-01-01T00:00:00Z", delivery: { id: "attempt", state: "accepted", retryable: false, updatedAt: 0 } };
  expect(invitationStatusText(invitation)).toContain("expired");
  expect(invitationStatusText({ ...invitation, status: "canceled" })).toContain("canceled");
  expect(invitationStatusText({ ...invitation, expiresAt: "2100-01-01T00:00:00Z", delivery: { ...invitation.delivery, state: "uncertain", retryable: true } })).toContain("acceptance is unknown");
});
