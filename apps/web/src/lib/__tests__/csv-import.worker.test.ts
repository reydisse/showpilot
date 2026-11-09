import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedRelayMember } from "@/test/relay-fixtures";
const auth = vi.hoisted(() => ({ userId: "", sessionId: "" }));
vi.mock("../auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () => ({
        user: { id: auth.userId },
        session: { id: auth.sessionId },
      }),
    },
  }),
}));
import { writeCsvImport, readCsvImportContext } from "../csv-import.server";
import type { CsvImportCommand } from "../csv-import-contract";
const headers = new Headers();
async function fixture() {
  const actor = await seedRelayMember(`csv-${crypto.randomUUID()}`);
  Object.assign(auth, actor);
  const scope = { orgId: actor.orgId, userId: actor.userId };
  const command = (
    csv = "name,email,role\nOperator,operator@import.invalid,Camera",
  ): CsvImportCommand => ({
    ...scope,
    requestId: crypto.randomUUID(),
    expiresAt: Date.now() + 25000,
    csv,
  });
  const write = (input: CsvImportCommand, mode: "write" | "review" = "write") =>
    writeCsvImport(headers, input, mode, env.DB);
  const roster = async () =>
    (
      await env.DB.prepare(
        "SELECT id,name,email,role,memberId FROM crew_member WHERE orgId=? ORDER BY name",
      )
        .bind(actor.orgId)
        .all()
    ).results;
  return { actor, scope, command, write, roster };
}
it("stores one import result for concurrent exact retries and does not recreate deleted rows", async () => {
  const f = await fixture(),
    input = f.command();
  const [a, b] = await Promise.all([f.write(input), f.write(input)]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    outcome: "applied",
    summary: { imported: 1, skipped: 0, errors: [] },
  });
  expect(await f.roster()).toHaveLength(1);
  await env.DB.prepare("DELETE FROM crew_member WHERE orgId=?")
    .bind(f.actor.orgId)
    .run();
  expect(await f.write(input)).toEqual(a);
  expect(await f.roster()).toEqual([]);
});
it("deduplicates different concurrent imports by normalized email", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([
    f.write(f.command()),
    f.write(f.command("name,email\nOther name,OPERATOR@IMPORT.INVALID")),
  ]);
  if (a.outcome !== "applied" || b.outcome !== "applied")
    throw new Error("not applied");
  expect(a.summary.imported + b.summary.imported).toBe(1);
  expect(a.summary.skipped + b.summary.skipped).toBe(1);
  expect(await f.roster()).toHaveLength(1);
});
it("preserves partial row errors, Planning Center names, duplicate skips and default roles", async () => {
  const f = await fixture();
  const result = await f.write(
    f.command(
      "First Name,Last Name,Email Address,Position\nJane,Smith,jane@import.invalid,Camera\nInvalid,Row,not-email,Audio\nJane,Again,JANE@IMPORT.INVALID,\nSam,New,sam@import.invalid,",
    ),
  );
  expect(result).toMatchObject({
    outcome: "applied",
    summary: { imported: 2, skipped: 1, errors: [{ line: 3 }] },
  });
  expect(await f.roster()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Jane Smith", role: "Camera" }),
      expect.objectContaining({ name: "Sam New", role: "Crew" }),
    ]),
  );
});
it("caps concurrent imports at the existing free-plan roster limit", async () => {
  const f = await fixture(),
    csv = (prefix: string) =>
      "name,email\n" +
      Array.from(
        { length: 4 },
        (_, i) => `${prefix}${i},${prefix}${i}@import.invalid`,
      ).join("\n");
  const results = await Promise.all([
    f.write(f.command(csv("a"))),
    f.write(f.command(csv("b"))),
  ]);
  expect(await f.roster()).toHaveLength(5);
  expect(
    results.reduce(
      (total, r) =>
        total + (r.outcome === "applied" ? r.summary.errors.length : 0),
      0,
    ),
  ).toBe(3);
});
it("imports the maximum file size in rows using the unchanged pro limit", async () => {
  const f = await fixture();
  await env.DB.prepare(
    "UPDATE organization SET plan='pro',subscriptionStatus='active' WHERE id=?",
  )
    .bind(f.actor.orgId)
    .run();
  const input = f.command(
    "name,email\n" +
      Array.from(
        { length: 500 },
        (_, i) => `Person ${i},person${i}@import.invalid`,
      ).join("\n"),
  );
  const result = await f.write(input);
  expect(result).toMatchObject({
    outcome: "applied",
    summary: { imported: 100, skipped: 0 },
  });
  if (result.outcome !== "applied") throw new Error("not applied");
  expect(result.summary.errors).toHaveLength(400);
  expect(result.summary.errors[0].line).toBe(102);
  expect(await f.roster()).toHaveLength(100);
  expect(await f.write(input)).toEqual(result);
});
it("retains active-trial entitlement rules", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE organization SET trialEndsAt=? WHERE id=?")
    .bind(Date.now() + 3600000, f.actor.orgId)
    .run();
  const result = await f.write(
    f.command(
      "name,email\n" +
        Array.from(
          { length: 6 },
          (_, i) => `Trial ${i},trial${i}@import.invalid`,
        ).join("\n"),
    ),
  );
  expect(result).toMatchObject({
    outcome: "applied",
    summary: { imported: 6, errors: [] },
  });
});
it("retains beta access before launch and the free limit after launch", async () => {
  const f = await fixture();
  await env.DB.prepare("UPDATE organization SET betaTester=1 WHERE id=?")
    .bind(f.actor.orgId)
    .run();
  await env.DB.prepare(
    "DELETE FROM platform_setting WHERE key='publicLaunchDate'",
  ).run();
  const csv =
    "name,email\n" +
    Array.from(
      { length: 6 },
      (_, i) => `Beta ${i},beta${i}@import.invalid`,
    ).join("\n");
  expect(await f.write(f.command(csv))).toMatchObject({
    outcome: "applied",
    summary: { imported: 6, errors: [] },
  });
  await env.DB.prepare("DELETE FROM crew_member WHERE orgId=?")
    .bind(f.actor.orgId)
    .run();
  await env.DB.prepare(
    "INSERT INTO platform_setting(id,key,value) VALUES('csv-beta-launch','publicLaunchDate',?)",
  )
    .bind(new Date(Date.now() - 3600000).toISOString())
    .run();
  const result = await f.write(f.command(csv));
  expect(result).toMatchObject({
    outcome: "applied",
    summary: { imported: 5 },
  });
  if (result.outcome !== "applied") throw new Error("not applied");
  expect(result.summary.errors).toHaveLength(1);
});
it("review cancels an undelivered import and returns an already committed outcome honestly", async () => {
  const f = await fixture(),
    input = f.command();
  expect((await f.write(input, "review")).outcome).toBe("cancelled");
  expect((await f.write(input)).outcome).toBe("cancelled");
  expect(await f.roster()).toEqual([]);
  const other = f.command(),
    result = await f.write(other);
  expect(await f.write(other, "review")).toEqual(result);
});
it("rejects expired requests, changed payloads and account mismatches", async () => {
  const f = await fixture(),
    expired = f.command();
  expired.expiresAt = Date.now() - 1000;
  expect((await f.write(expired)).outcome).toBe("expired");
  const input = f.command();
  await f.write(input);
  await expect(
    f.write({ ...input, csv: input.csv.replace("Operator", "Other name") }),
  ).rejects.toThrow("different CSV");
  await expect(
    f.write({ ...f.command(), userId: crypto.randomUUID() }),
  ).rejects.toThrow("account changed");
  expect(await f.roster()).toHaveLength(1);
});
it("does not expose another organization's import context or write to it", async () => {
  const f = await fixture(),
    other = await seedRelayMember(`other-${crypto.randomUUID()}`);
  await expect(
    readCsvImportContext(headers, { ...f.scope, orgId: other.orgId }, env.DB),
  ).rejects.toThrow();
  await expect(
    f.write({ ...f.command(), orgId: other.orgId }),
  ).rejects.toThrow();
});
it("checks permission again when admitting an import", async () => {
  const f = await fixture();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare(
        "UPDATE member SET role='member' WHERE organizationId=? AND userId=?",
      )
        .bind(f.actor.orgId, f.actor.userId)
        .run();
      return env.DB.batch<T>(statements);
    },
  };
  await expect(
    writeCsvImport(headers, f.command(), "write", db),
  ).rejects.toThrow("not confirmed");
  expect(await f.roster()).toEqual([]);
});
it("does not apply an import using a plan snapshot changed before commit", async () => {
  const f = await fixture();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare("UPDATE organization SET plan='starter' WHERE id=?")
        .bind(f.actor.orgId)
        .run();
      return env.DB.batch<T>(statements);
    },
  };
  expect(
    (await writeCsvImport(headers, f.command(), "write", db)).outcome,
  ).toBe("conflict");
  expect(await f.roster()).toEqual([]);
});
it("rolls back the result with a failed import transaction", async () => {
  const f = await fixture(),
    input = f.command();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: <T>(statements: D1PreparedStatement[]) =>
      env.DB.batch<T>([
        ...statements,
        env.DB.prepare(
          "INSERT INTO crew_member(id,orgId,memberId,name) VALUES(NULL,NULL,NULL,NULL)",
        ),
      ]),
  };
  await expect(writeCsvImport(headers, input, "write", db)).rejects.toThrow();
  expect(await f.roster()).toEqual([]);
  expect((await f.write(input)).outcome).toBe("applied");
  expect(await f.roster()).toHaveLength(1);
});
