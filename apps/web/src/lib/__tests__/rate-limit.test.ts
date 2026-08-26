import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, isRateLimited, type RateLimitDatabase } from "../rate-limit";

vi.mock("cloudflare:workers", () => ({ env: {} }));

interface StatementCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(input: {
  calls: StatementCall[];
  insertChanges?: number;
  insertFails?: boolean;
  cleanupFails?: boolean;
}): RateLimitDatabase {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          input.calls.push({ sql, params });
          return {
            async run() {
              if (sql.startsWith("DELETE") && input.cleanupFails) {
                throw new Error("cleanup unavailable");
              }
              if (sql.startsWith("INSERT") && input.insertFails) {
                throw new Error("storage unavailable");
              }
              return {
                success: true,
                meta: { changes: sql.startsWith("INSERT") ? (input.insertChanges ?? 1) : 1 },
              };
            },
          };
        },
      };
    },
  };
}

describe("D1 rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("counts and admits a request in one atomic statement", async () => {
    const calls: StatementCall[] = [];
    const db = fakeDatabase({ calls, insertChanges: 1 });

    await expect(isRateLimited("waitlist:203.0.113.5", {
      max: 5,
      windowSeconds: 3_600,
    }, { db })).resolves.toBe(false);

    expect(calls[0]?.sql).toContain("INSERT INTO rate_limit_event");
    expect(calls[0]?.sql).toContain("SELECT COUNT(*) FROM rate_limit_event");
    expect(calls[0]?.params.slice(1)).toEqual([
      "waitlist:203.0.113.5",
      1_787_745_600,
      "waitlist:203.0.113.5",
      1_787_742_000,
      5,
    ]);
  });

  it("rejects when the atomic insert observes a full window", async () => {
    const calls: StatementCall[] = [];
    const db = fakeDatabase({ calls, insertChanges: 0 });

    await expect(isRateLimited("companion:org-1", {
      max: 120,
      windowSeconds: 60,
    }, { db })).resolves.toBe(true);
  });

  it("does not reverse a rate-limit decision when cleanup fails", async () => {
    const calls: StatementCall[] = [];
    const db = fakeDatabase({ calls, insertChanges: 0, cleanupFails: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(isRateLimited("companion:org-1", {
      max: 120,
      windowSeconds: 60,
    }, { db })).resolves.toBe(true);
  });

  it("keeps the documented fail-open behavior for a storage outage", async () => {
    const calls: StatementCall[] = [];
    const db = fakeDatabase({ calls, insertFails: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(isRateLimited("waitlist:203.0.113.5", {
      max: 5,
      windowSeconds: 3_600,
    }, { db })).resolves.toBe(false);
  });
});

describe("client IP extraction", () => {
  it("uses Cloudflare's trusted connection header only", () => {
    expect(clientIp(new Request("https://showpilot.tech", {
      headers: {
        "CF-Connecting-IP": "203.0.113.5",
        "X-Forwarded-For": "198.51.100.7",
      },
    }))).toBe("203.0.113.5");
    expect(clientIp(new Request("http://localhost"))).toBe("");
  });
});
