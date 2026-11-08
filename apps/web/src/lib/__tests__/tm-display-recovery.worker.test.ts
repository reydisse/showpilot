import { setKioskBlanked } from "../kiosk-display-command.server";
import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { seedRelayMember } from "@/test/relay-fixtures";
import { getPrisma } from "../db";
import { getAuth } from "../auth";
import {
  getTechnicalKioskDisplay,
  writeTechnicalKioskDisplay,
} from "../technical-kiosk-display";
import { getKioskBlankState, setKioskBlankState } from "../kiosk-display";
import {
  readKioskDisplaySnapshot,
  writeKioskDisplay,
  type KioskDisplayDatabase,
} from "../kiosk-display-command.server";
import { runTmControl } from "../tm-operations";
const auth = vi.hoisted(() => ({ cookie: "", ip: 0 }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "test-cookie-bridge" }),
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => new Headers({ Cookie: auth.cookie }),
  setResponseHeader: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => {
  const builder = () => {
    let validate = (value: unknown) => value;
    const chain = {
      middleware: () => chain,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return chain;
      },
      handler:
        (fn: (input: { data: unknown }) => unknown) =>
        async (input: { data: unknown }) =>
          fn({ data: validate(input.data) }),
      server: () => chain,
    };
    return chain;
  };
  return {
    createServerFn: builder,
    createMiddleware: builder,
    createServerOnlyFn: <T>(fn: T): T => fn,
  };
});

let authenticated: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  auth.cookie = "";
  authenticated = await fixture();
});
async function fixture() {
  const { orgId, userId } = await seedRelayMember(crypto.randomUUID());
  const password = "Disposable-crew-password-92!";
  await getPrisma().account.create({
    data: {
      id: crypto.randomUUID(),
      issuer: "local:credential",
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
  const login = await getAuth().handler(
    new Request("https://app.showpilot.tech/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://app.showpilot.tech",
        "cf-connecting-ip": `192.0.2.${++auth.ip}`,
      },
      body: JSON.stringify({ email: `${userId}@example.test`, password }),
    }),
  );
  expect(login.status).toBe(200);
  await login.arrayBuffer();
  auth.cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  const session = await getAuth().api.getSession({
    headers: new Headers({ Cookie: auth.cookie }),
    query: { disableCookieCache: true },
  });
  if (!session) throw new Error("Fixture session missing");
  return { orgId, userId, actor: { userId, sessionId: session.session.id } };
}

it("does not re-blank restored kiosks when a technical-dashboard reply is lost", async () => {
  const { orgId } = authenticated;
  const data = {
    orgId,
    blanked: true,
    requestId: crypto.randomUUID(),
    expectedRevision: null,
  };
  await writeTechnicalKioskDisplay({ data });
  await setKioskBlanked(orgId, false);
  await writeTechnicalKioskDisplay({ data });
  expect((await readKioskDisplaySnapshot(orgId)).blanked).toBe(false);
});
it("does not overwrite a newer kiosk decision from a stale technical confirmation", async () => {
  const { orgId } = authenticated;
  const reviewed = await readKioskDisplaySnapshot(orgId);
  await setKioskBlanked(orgId, true);
  await setKioskBlanked(orgId, false);
  await writeTechnicalKioskDisplay({
    data: {
      orgId,
      blanked: true,
      requestId: crypto.randomUUID(),
      expectedRevision: reviewed.revision,
    },
  }).catch(() => {});
  expect((await readKioskDisplaySnapshot(orgId)).blanked).toBe(false);
});

const command = () => ({
  orgId: authenticated.orgId,
  requestId: crypto.randomUUID(),
  expectedRevision: null,
  blanked: true,
});
async function role(value: string) {
  await env.DB.prepare(
    "UPDATE member SET role=? WHERE organizationId=? AND userId=?",
  )
    .bind(value, authenticated.orgId, authenticated.userId)
    .run();
}
async function grant() {
  const { orgId, userId } = authenticated;
  await role("member");
  await env.DB.prepare(
    "INSERT INTO member_permission_grant(id,orgId,userId,capability,permissions,startsOn,expiresOn,grantedByUserId) VALUES(?,?,?,'device-operator','[\"devices:access\",\"dashboard:tm\"]','2000-01-01','2099-01-01',?)",
  )
    .bind(crypto.randomUUID(), orgId, userId, userId)
    .run();
}
it("preserves TM dashboard controls without granting Settings management", async () => {
  await role("tm");
  const data = command();
  expect(
    await getTechnicalKioskDisplay({ data: { orgId: data.orgId } }),
  ).toEqual({ blanked: false, revision: null });
  expect((await writeTechnicalKioskDisplay({ data })).outcome).toBe("applied");
  await expect(
    getKioskBlankState({ data: { orgId: data.orgId } }),
  ).rejects.toThrow("permission");
  await expect(setKioskBlankState({ data })).rejects.toThrow("permission");
});
it("accepts a current device-operator grant and denies replay after revocation", async () => {
  await grant();
  const data = command();
  expect((await writeTechnicalKioskDisplay({ data })).outcome).toBe("applied");
  await env.DB.prepare(
    "UPDATE member_permission_grant SET revokedAt=CURRENT_TIMESTAMP WHERE orgId=?",
  )
    .bind(data.orgId)
    .run();
  await expect(writeTechnicalKioskDisplay({ data })).rejects.toThrow(
    "permission",
  );
});
it.each(["revoked", "expired", "permissions", "timezone"])(
  "rechecks %s temporary access at the atomic commit",
  async (kind) => {
    await grant();
    const data = command();
    const database: KioskDisplayDatabase = {
      prepare: (sql) => env.DB.prepare(sql),
      batch: async (statements) => {
        if (kind === "timezone")
          await env.DB.prepare(
            "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'org-timezone','Pacific/Honolulu')",
          )
            .bind(crypto.randomUUID(), data.orgId)
            .run();
        else
          await env.DB.prepare(
            kind === "revoked"
              ? "UPDATE member_permission_grant SET revokedAt=CURRENT_TIMESTAMP WHERE orgId=?"
              : kind === "expired"
                ? "UPDATE member_permission_grant SET expiresOn='2000-01-01' WHERE orgId=?"
                : "UPDATE member_permission_grant SET permissions='[]' WHERE orgId=?",
          )
            .bind(data.orgId)
            .run();
        return env.DB.batch(statements);
      },
    };
    await expect(
      writeKioskDisplay({
        command: data,
        actor: authenticated.actor,
        surface: "technical",
        database,
      }),
    ).rejects.toThrow("access changed");
    expect(await readKioskDisplaySnapshot(data.orgId)).toEqual({
      blanked: false,
      revision: null,
    });
  },
);
it("shares receipts with Settings without replaying a superseded command", async () => {
  const data = command(),
    saved = await writeTechnicalKioskDisplay({ data });
  await setKioskBlankState({
    data: {
      ...data,
      requestId: crypto.randomUUID(),
      expectedRevision: saved.snapshot.revision,
      blanked: false,
    },
  });
  const replay = await writeTechnicalKioskDisplay({ data });
  expect(replay.outcome).toBe("superseded");
  expect(replay.snapshot.blanked).toBe(false);
});
it("rejects inactive, malformed and unrelated grants", async () => {
  await grant();
  const data = command();
  for (const permissions of [
    '{"permission":"dashboard:tm"}',
    "not-json",
    '["stream_health:manage"]',
  ]) {
    await env.DB.prepare(
      "UPDATE member_permission_grant SET permissions=? WHERE orgId=?",
    )
      .bind(permissions, data.orgId)
      .run();
    await expect(writeTechnicalKioskDisplay({ data })).rejects.toThrow(
      "permission",
    );
  }
  await env.DB.prepare(
    "UPDATE member_permission_grant SET permissions='[\"dashboard:tm\"]',startsOn='2099-01-01' WHERE orgId=?",
  )
    .bind(data.orgId)
    .run();
  await expect(writeTechnicalKioskDisplay({ data })).rejects.toThrow(
    "permission",
  );
});
it("denies cross-org access and a revoked real session", async () => {
  const other = await seedRelayMember(crypto.randomUUID()),
    data = command();
  await expect(
    writeTechnicalKioskDisplay({ data: { ...data, orgId: other.orgId } }),
  ).rejects.toThrow("permission");
  await env.DB.prepare("DELETE FROM session WHERE id=?")
    .bind(authenticated.actor.sessionId)
    .run();
  await expect(writeTechnicalKioskDisplay({ data })).rejects.toThrow("Sign in");
});
it("removes the unconditional blank and restore actions from the legacy RPC", async () => {
  for (const action of ["displays-blank", "displays-restore"])
    await expect(
      runTmControl({ data: { orgId: authenticated.orgId, action } }),
    ).rejects.toThrow();
});

it("evaluates temporary access on the organization day rather than the UTC date", async () => {
  await grant();
  const data = command(),
    now = new Date();
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  const utc = format("UTC"),
    timezone = ["Pacific/Kiritimati", "Etc/GMT+12"].find(
      (zone) => format(zone) !== utc,
    );
  expect(timezone).toBeTruthy();
  if (!timezone) throw new Error("No alternate local date");
  const today = format(timezone),
    next = new Date(`${today}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  await env.DB.prepare(
    "INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,'org-timezone',?)",
  )
    .bind(crypto.randomUUID(), data.orgId, timezone)
    .run();
  await env.DB.prepare(
    "UPDATE member_permission_grant SET startsOn=?,expiresOn=? WHERE orgId=?",
  )
    .bind(today, next.toISOString().slice(0, 10), data.orgId)
    .run();
  expect((await writeTechnicalKioskDisplay({ data })).outcome).toBe("applied");
});
