import { afterEach, expect, it } from "vitest";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { accessCommandSchema, accessMutationOptions, accessReceiptSchema } from "../../../../mobile/src/lib/access-recovery.ts";
import { createLocalRequestUuid } from "../../../../mobile/src/lib/request-id.ts";
afterEach(() => onlineManager.setOnline(true));
it.each(["grant", "revoke", "notice"])("retains the exact native %s across screens and isolates accounts and organizations", async kind => {
  const client = new QueryClient();
  const key = ["access-command", "org", "user"];
  const command = accessCommandSchema.parse({ kind, orgId: "org", requestId: createLocalRequestUuid(), expectedWeekStart: "2026-11-01", userId: "target", capability: "rundown-operator", duration: "this-week", reason: "Covering production", grantId: "grant" });
  const requests = [];
  const results = [];
  const receipt = { ok: true, id: "grant", requestId: command.requestId, kind: kind === "revoke" ? "revoke" : "grant", state: "revoked", notification: "pending" };
  const options = accessMutationOptions({ key, client, execute: async input => {
    requests.push(input);
    if (requests.length === 1) throw new Error("Reply lost");
    return accessReceiptSchema.parse(receipt);
  }, confirmed: (result, input) => results.push({ result, input }) });
  try {
    await expect(client.getMutationCache().build(client, options).execute(command)).rejects.toThrow("Reply lost");
    const reopened = client.getMutationCache().findAll({ mutationKey: key, exact: true }).at(-1);
    expect(reopened.state.status).toBe("error");
    expect(client.getMutationCache().findAll({ mutationKey: ["access-command", "org", "other"], exact: true })).toHaveLength(0);
    expect(client.getMutationCache().findAll({ mutationKey: ["access-command", "other", "user"], exact: true })).toHaveLength(0);
    onlineManager.setOnline(false);
    await client.getMutationCache().build(client, options).execute(accessCommandSchema.parse(reopened.state.variables));
    expect(requests).toEqual([command, command]);
    expect(results).toEqual([{ result: receipt, input: command }]);
    const remaining = client.getMutationCache().findAll({ mutationKey: key, exact: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].state.status).toBe("success");
  } finally { client.clear(); }
});
it("rejects incomplete native grant recovery data instead of creating a new request", () => {
  expect(accessCommandSchema.safeParse({ kind: "grant", orgId: "org", userId: "target", capability: "rundown-operator", duration: "this-week", reason: "" }).success).toBe(false);
  expect(accessCommandSchema.safeParse({ kind: "notice", orgId: "org", requestId: "not-the-saved-uuid" }).success).toBe(false);
});
