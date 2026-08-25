import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMobileApi, type MobileApiDatabase } from "../mobile-api.server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveAccess: vi.fn(),
}));

vi.mock("../auth", () => ({
  getAuth: () => ({ api: { getSession: mocks.getSession } }),
}));

vi.mock("../effective-access", () => ({
  resolveEffectiveAccess: mocks.resolveAccess,
}));

interface StatementCall {
  sql: string;
  params: unknown[];
}

function fakeDatabase(calls: StatementCall[]): MobileApiDatabase {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            async first<T>() {
              return (sql.startsWith("SELECT id FROM organization WHERE id = ?")
                ? { id: "org-1" }
                : null) as T | null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              return {};
            },
          };
        },
      };
    },
  };
}

describe("mobile push registration", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1", name: "Test Person", email: "test@example.com" },
    });
    mocks.resolveAccess.mockResolvedValue({ role: "member", permissions: [] });
  });

  it("removes a signed-out device token from every organization for that user", async () => {
    const calls: StatementCall[] = [];
    const token = "ExponentPushToken[abcdefghijk]";
    const response = await handleMobileApi(
      new Request("https://showpilot.tech/api/mobile/v1/push-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: "org-1", token, platform: "ios", enabled: false }),
      }),
      {
        DB: fakeDatabase(calls),
      },
    );

    expect(response?.status).toBe(200);
    const deletion = calls.find((call) => call.sql.startsWith("DELETE FROM push_subscription"));
    expect(deletion).toEqual({
      sql: "DELETE FROM push_subscription WHERE endpoint = ? AND userId = ?",
      params: [token, "user-1"],
    });
  });
});
