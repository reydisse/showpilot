type ExpoPushReceiptRow = {
  id: string;
  ticketId: string;
  subscriptionId: string;
  createdAtMs: number;
};

export interface ExpoPushReceiptDatabase {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

type ExpoPushReceipt =
  | { status: "ok" }
  | { status: "error"; message: string; error: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expoError(value: unknown): string | null {
  return isRecord(value) && typeof value.error === "string" ? value.error : null;
}

function parseExpoPushReceipt(value: unknown): ExpoPushReceipt | null {
  if (!isRecord(value)) return null;
  if (value.status === "ok") return { status: "ok" };
  if (value.status === "error") {
    return {
      status: "error",
      message: typeof value.message === "string" ? value.message : "Expo could not deliver the push",
      error: expoError(value.details),
    };
  }
  return null;
}

export function expoPushHeaders(accessToken?: string): Record<string, string> {
  const token = accessToken?.trim() ?? "";
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function checkExpoPushReceipts(
  db: ExpoPushReceiptDatabase,
  options: { accessToken?: string; fetcher?: typeof fetch } = {},
): Promise<{ checked: number; removedSubscriptions: number }> {
  const pending = await db.prepare(
    `SELECT id, ticketId, subscriptionId, unixepoch(createdAt) * 1000 AS createdAtMs
     FROM expo_push_receipt
     WHERE nextCheckAt <= CURRENT_TIMESTAMP
     ORDER BY nextCheckAt ASC
     LIMIT 1000`,
  ).bind().all<ExpoPushReceiptRow>();
  const rows = pending.results ?? [];
  if (!rows.length) return { checked: 0, removedSubscriptions: 0 };

  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher("https://exp.host/--/api/v2/push/getReceipts", {
    method: "POST",
    headers: expoPushHeaders(options.accessToken),
    body: JSON.stringify({ ids: rows.map((row) => row.ticketId) }),
  });
  if (!response.ok) throw new Error(`Expo receipt service returned ${response.status}`);
  const result: unknown = await response.json();
  const receipts = isRecord(result) && isRecord(result.data) ? result.data : {};
  let removedSubscriptions = 0;

  await Promise.all(rows.map(async (row) => {
    const receipt = parseExpoPushReceipt(receipts[row.ticketId]);
    if (!receipt) {
      const expired = Date.now() - row.createdAtMs >= 24 * 3_600_000;
      if (expired) {
        await db.prepare("DELETE FROM expo_push_receipt WHERE id = ?").bind(row.id).run();
      } else {
        await db.prepare(
          "UPDATE expo_push_receipt SET nextCheckAt = datetime('now', '+5 minutes') WHERE id = ?",
        ).bind(row.id).run();
      }
      return;
    }

    if (receipt.status === "error") {
      if (receipt.error === "DeviceNotRegistered") {
        await db.prepare("DELETE FROM push_subscription WHERE id = ?")
          .bind(row.subscriptionId).run();
        removedSubscriptions += 1;
      } else {
        console.error("[Push] Expo receipt failed", {
          error: receipt.error ?? "UnknownReceiptError",
          message: receipt.message,
          ticketId: row.ticketId,
        });
      }
    }
    await db.prepare("DELETE FROM expo_push_receipt WHERE id = ?").bind(row.id).run();
  }));

  return { checked: rows.length, removedSubscriptions };
}
