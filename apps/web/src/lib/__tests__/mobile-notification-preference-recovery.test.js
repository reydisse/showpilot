import { afterEach, expect, it } from "vitest";
import { QueryClient, onlineManager, replaceEqualDeep } from "@tanstack/react-query";
import { preferenceCommandSchema, preferenceMutationOptions, preferenceReceiptSchema, preferenceMutationSnapshot } from "../../../../mobile/src/lib/notification-preference-recovery.ts";
import { createLocalRequestUuid } from "../../../../mobile/src/lib/request-id.ts";
afterEach(() => onlineManager.setOnline(true));
it.each(["applied", "conflict", "superseded"])("retains the exact native request and reports %s after recovery", async outcome => {
  const client = new QueryClient(); const key = ["notification-preference-change", "org", "user"];
  const command = preferenceCommandSchema.parse({ orgId: "org", requestId: createLocalRequestUuid(), category: "schedule", deviceAlerts: false, expectedDeviceAlerts: true });
  const requests = [], receipts = [];
  const result = { outcome, preference: { category: "schedule", deviceAlerts: outcome !== "applied" }, preferences: [{ category: "schedule", deviceAlerts: outcome !== "applied" }] };
  const options = preferenceMutationOptions({ key, client, execute: async input => {
    requests.push(input); if (requests.length === 1) throw new Error("Reply lost");
    return preferenceReceiptSchema.parse(result);
  }, confirmed: receipt => { receipts.push(receipt); } });
  try {
    await expect(client.getMutationCache().build(client, options).execute(command)).rejects.toThrow("Reply lost");
    const reopened = client.getMutationCache().findAll({ mutationKey: key, exact: true }).at(-1);
    expect(reopened.state.status).toBe("error");
    expect(client.getMutationCache().findAll({ mutationKey: ["notification-preference-change", "org", "other"], exact: true })).toHaveLength(0);
    expect(client.getMutationCache().findAll({ mutationKey: ["notification-preference-change", "other", "user"], exact: true })).toHaveLength(0);
    onlineManager.setOnline(false);
    await client.getMutationCache().build(client, options).execute(preferenceCommandSchema.parse(reopened.state.variables));
    expect(requests).toEqual([command, command]); expect(receipts).toEqual([result]);
    expect(client.getMutationCache().findAll({ mutationKey: key, exact: true })).toHaveLength(1);
  } finally { client.clear(); }
});
it("rejects incomplete recovery commands and receipts", () => {
  expect(preferenceCommandSchema.safeParse({ orgId: "org", category: "schedule", deviceAlerts: false }).success).toBe(false);
  expect(preferenceReceiptSchema.safeParse({ preferences: [] }).success).toBe(false);
});

it("keeps native pending and failed snapshots structurally stable", () => {
  const variables = { orgId: "org", requestId: createLocalRequestUuid(), category: "chat", deviceAlerts: false, expectedDeviceAlerts: true };
  for (const state of [{ status: "pending", variables, data: undefined, error: null }, { status: "error", variables, data: undefined, error: new Error("Offline") }]) {
    const first = preferenceMutationSnapshot(state);
    expect(first.receipt).toBeNull();
    expect(replaceEqualDeep(first, preferenceMutationSnapshot(state))).toBe(first);
  }
});
