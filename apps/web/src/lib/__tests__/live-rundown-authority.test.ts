import { describe, expect, it } from "vitest";
import { hasLiveRundownAuthority } from "../live-rundown-authority.server";

interface Fixture {
  sessionActive: boolean;
  role: "member" | "tm";
  grants: string[];
  configuredPin?: string;
}

function database(fixture: Fixture) {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM session")) {
                return (fixture.sessionActive
                  ? { expiresAt: "2099-01-01T00:00:00.000Z" }
                  : null) as T | null;
              }
              if (sql.includes("FROM member WHERE")) return { role: fixture.role } as T;
              if (sql.includes("key = 'org-timezone'")) return { value: "UTC" } as T;
              if (sql.includes("FROM member_permission_grant")) {
                return {
                  grantSets: JSON.stringify(fixture.grants.map((permission) => JSON.stringify([permission]))),
                  revision: "1",
                } as T;
              }
              if (sql.includes("FROM app_setting") && params[1] === "rundown-pin") {
                return fixture.configuredPin ? { value: fixture.configuredPin } as T : null;
              }
              return null;
            },
          };
        },
      };
    },
  };
}

const claim = {
  userId: "member-1",
  sessionId: "session-1",
  orgId: "org-1",
  rundownPin: null,
};

describe("live rundown command authority", () => {
  it("rejects the same socket claim after its grant is revoked", async () => {
    await expect(hasLiveRundownAuthority(
      database({ sessionActive: true, role: "member", grants: ["rundown:edit"] }),
      claim,
      "rundown:edit",
    )).resolves.toBe(true);

    await expect(hasLiveRundownAuthority(
      database({ sessionActive: true, role: "member", grants: [] }),
      claim,
      "rundown:edit",
    )).resolves.toBe(false);
  });

  it("rejects an otherwise-authorized claim after sign-out", async () => {
    await expect(hasLiveRundownAuthority(
      database({ sessionActive: false, role: "member", grants: ["rundown:edit"] }),
      claim,
      "rundown:edit",
    )).resolves.toBe(false);
  });

  it("rechecks the current PIN for roles that require it", async () => {
    const db = database({ sessionActive: true, role: "tm", grants: [], configuredPin: "2468" });
    await expect(hasLiveRundownAuthority(db, { ...claim, rundownPin: "2468" }, "rundown:view"))
      .resolves.toBe(true);
    await expect(hasLiveRundownAuthority(db, { ...claim, rundownPin: "1357" }, "rundown:view"))
      .resolves.toBe(false);
  });
});
