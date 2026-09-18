import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1RateLimitStorage } from "../auth-rate-limit.server";

interface FakeRow {
  count: number;
  lastRequest: number;
}

function createDatabase(row: FakeRow | null, cleanupError?: Error) {
  const preparedSql: string[] = [];
  const boundValues: unknown[][] = [];
  const database = {
    prepare(sql: string) {
      preparedSql.push(sql);
      return {
        bind(...values: unknown[]) {
          boundValues.push(values);
          return {
            async first<T>() {
              return row as T | null;
            },
            async run() {
              if (cleanupError) throw cleanupError;
              return { success: true };
            },
          };
        },
      };
    },
  };

  return { database, preparedSql, boundValues };
}

describe("D1 authentication rate-limit storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("atomically consumes an allowed request", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fake = createDatabase({ count: 3, lastRequest: 8_000 });
    const storage = createD1RateLimitStorage(fake.database);

    await expect(storage.consume("signin:client", { window: 60, max: 10 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });

    expect(fake.preparedSql).toHaveLength(1);
    expect(fake.preparedSql[0]).toContain("ON CONFLICT(key) DO UPDATE");
    expect(fake.preparedSql[0]).toContain("RETURNING count, lastRequest");
    expect(fake.boundValues).toEqual([
      ["signin:client", "signin:client", 10_000, -50_000, -50_000],
    ]);
  });

  it("blocks requests over the limit and reports the remaining window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(70_000);
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fake = createDatabase({ count: 11, lastRequest: 40_000 });
    const storage = createD1RateLimitStorage(fake.database);

    await expect(storage.consume("signin:client", { window: 60, max: 10 })).resolves.toEqual({
      allowed: false,
      retryAfter: 30,
    });
  });

  it("fails closed when D1 does not return the consumed row", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const fake = createDatabase(null);
    const storage = createD1RateLimitStorage(fake.database);

    await expect(storage.consume("signin:client", { window: 60, max: 10 })).resolves.toEqual({
      allowed: false,
      retryAfter: 60,
    });
  });

  it("does not reject authentication when opportunistic cleanup fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fake = createDatabase(
      { count: 1, lastRequest: 10_000 },
      new Error("temporary cleanup failure"),
    );
    const storage = createD1RateLimitStorage(fake.database);

    await expect(storage.consume("signin:client", { window: 60, max: 10 })).resolves.toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect(fake.preparedSql).toHaveLength(2);
  });
});
