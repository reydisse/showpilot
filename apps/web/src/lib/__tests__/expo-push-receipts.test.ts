import { describe, expect, it, vi } from "vitest";
import {
  checkExpoPushReceipts,
  type ExpoPushReceiptDatabase,
} from "../expo-push-receipts.server";

interface ReceiptRow {
  id: string;
  ticketId: string;
  subscriptionId: string;
  createdAtMs: number;
}

interface StatementCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(rows: ReceiptRow[], calls: StatementCall[]): ExpoPushReceiptDatabase {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            async all<T>() {
              return { results: rows as T[] };
            },
            async run() {
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function pendingReceipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: "receipt-row-1",
    ticketId: "ticket-1",
    subscriptionId: "subscription-1",
    createdAtMs: Date.now() - 20 * 60_000,
    ...overrides,
  };
}

describe("Expo push receipt checks", () => {
  it("does not call Expo when no receipt is due", async () => {
    const fetcher = vi.fn(async () => new Response());

    await expect(checkExpoPushReceipts(fakeDatabase([], []), { fetcher })).resolves.toEqual({
      checked: 0,
      removedSubscriptions: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deletes a completed receipt", async () => {
    const calls: StatementCall[] = [];
    const fetcher = vi.fn(async () => Response.json({
      data: { "ticket-1": { status: "ok" } },
    }));

    await expect(checkExpoPushReceipts(
      fakeDatabase([pendingReceipt()], calls),
      { fetcher },
    )).resolves.toEqual({ checked: 1, removedSubscriptions: 0 });
    expect(calls.some((call) => call.sql === "DELETE FROM expo_push_receipt WHERE id = ?")).toBe(true);
  });

  it("removes a device subscription reported as unregistered", async () => {
    const calls: StatementCall[] = [];
    const fetcher = vi.fn(async () => Response.json({
      data: {
        "ticket-1": {
          status: "error",
          message: "The device is no longer registered",
          details: { error: "DeviceNotRegistered" },
        },
      },
    }));

    await expect(checkExpoPushReceipts(
      fakeDatabase([pendingReceipt()], calls),
      { fetcher },
    )).resolves.toEqual({ checked: 1, removedSubscriptions: 1 });
    expect(calls).toContainEqual({
      sql: "DELETE FROM push_subscription WHERE id = ?",
      params: ["subscription-1"],
    });
  });

  it("reschedules a receipt that Expo has not produced yet", async () => {
    const calls: StatementCall[] = [];
    const fetcher = vi.fn(async () => Response.json({ data: {} }));

    await checkExpoPushReceipts(fakeDatabase([pendingReceipt()], calls), { fetcher });

    expect(calls.some((call) => call.sql.startsWith("UPDATE expo_push_receipt SET nextCheckAt"))).toBe(true);
    expect(calls.some((call) => call.sql === "DELETE FROM expo_push_receipt WHERE id = ?")).toBe(false);
  });

  it("discards a receipt that remains missing after 24 hours", async () => {
    const calls: StatementCall[] = [];
    const fetcher = vi.fn(async () => Response.json({ data: {} }));

    await checkExpoPushReceipts(
      fakeDatabase([pendingReceipt({ createdAtMs: Date.now() - 25 * 3_600_000 })], calls),
      { fetcher },
    );

    expect(calls.some((call) => call.sql === "DELETE FROM expo_push_receipt WHERE id = ?")).toBe(true);
  });
});
