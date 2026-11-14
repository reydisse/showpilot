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
import {
  readEquipmentState,
  writeEquipmentCommand,
} from "../equipment-command.server";
import type {
  EquipmentCommand,
  EquipmentOperation,
} from "../equipment-command-contract";
const headers = new Headers();
async function fixture() {
  const actor = await seedRelayMember(`assets-${crypto.randomUUID()}`);
  Object.assign(auth, actor);
  const command = (operation: EquipmentOperation): EquipmentCommand => ({
    orgId: actor.orgId,
    userId: actor.userId,
    requestId: crypto.randomUUID(),
    expiresAt: Date.now() + 25_000,
    operation,
  });
  const create = () =>
    command({
      kind: "create",
      quantity: 1,
      fields: {
        name: "Microphone",
        category: "audio",
        status: "operational",
        location: "Stage",
        serialNumber: "MIC-1",
        notes: "Keep dry",
      },
    });
  const write = (input: EquipmentCommand, mode: "write" | "review" = "write") =>
    writeEquipmentCommand(headers, input, mode, env.DB);
  const read = () => readEquipmentState(headers, actor.orgId, env.DB);
  return { actor, command, create, write, read };
}
it("recovers one bulk creation under concurrent retries without duplicating serial numbers", async () => {
  const f = await fixture(),
    input = f.create();
  if (input.operation.kind !== "create") throw new Error("fixture");
  input.operation.quantity = 100;
  const [a, b] = await Promise.all([f.write(input), f.write(input)]);
  expect(a).toEqual(b);
  expect(a.outcome).toBe("applied");
  expect(a.ids).toHaveLength(100);
  const state = await f.read();
  expect(state.equipment).toHaveLength(100);
  expect(state.equipment.every((row) => row.serialNumber === "")).toBe(true);
  expect(await f.write(input)).toEqual(a);
});
it("a recovered update does not overwrite a later mobile-style revision", async () => {
  const f = await fixture(),
    created = await f.write(f.create()),
    id = created.ids[0];
  const input = f.command({
    kind: "update",
    id,
    expectedRevision: 0,
    updates: { notes: "First update" },
  });
  expect((await f.write(input)).outcome).toBe("applied");
  await env.DB.prepare(
    "UPDATE equipment SET notes='Later edit',revision=revision+1 WHERE orgId=? AND id=?",
  )
    .bind(f.actor.orgId, id)
    .run();
  expect((await f.write(input)).outcome).toBe("applied");
  expect((await f.read()).equipment[0]).toMatchObject({
    notes: "Later edit",
    revision: 2,
  });
});
it("conflict receipts do not turn into writes after the revision changes again", async () => {
  const f = await fixture(),
    {
      ids: [id],
    } = await f.write(f.create());
  const input = f.command({
    kind: "update",
    id,
    expectedRevision: 1,
    updates: { name: "Unsafe overwrite" },
  });
  expect((await f.write(input)).outcome).toBe("conflict");
  await env.DB.prepare("UPDATE equipment SET revision=1 WHERE id=?")
    .bind(id)
    .run();
  expect((await f.write(input)).outcome).toBe("conflict");
  expect((await f.read()).equipment[0].name).toBe("Microphone");
});
it("keeps legacy equipment values when updating a different field", async () => {
  const f = await fixture(),
    {
      ids: [id],
    } = await f.write(f.create());
  await env.DB.prepare(
    "UPDATE equipment SET category='Legacy rack',status='Legacy status' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(
    (
      await f.write(
        f.command({
          kind: "update",
          id,
          expectedRevision: 0,
          updates: { notes: "New note" },
        }),
      )
    ).outcome,
  ).toBe("applied");
  expect((await f.read()).equipment[0]).toMatchObject({
    category: "Legacy rack",
    status: "Legacy status",
    notes: "New note",
    revision: 1,
  });
});
it("recovers deletion after the row is gone and rejects stale delete confirmation", async () => {
  const f = await fixture(),
    {
      ids: [id],
    } = await f.write(f.create());
  expect(
    (await f.write(f.command({ kind: "delete", id, expectedRevision: 1 })))
      .outcome,
  ).toBe("conflict");
  const input = f.command({ kind: "delete", id, expectedRevision: 0 });
  const result = await f.write(input);
  expect(result.outcome).toBe("applied");
  expect(await f.write(input)).toEqual(result);
  expect((await f.read()).equipment).toEqual([]);
});
it("review cancels an undelivered create without applying a late arrival", async () => {
  const f = await fixture(),
    input = f.create();
  expect((await f.write(input, "review")).outcome).toBe("cancelled");
  expect((await f.write(input)).outcome).toBe("cancelled");
  expect((await f.read()).equipment).toEqual([]);
});
it("review returns a completed result rather than claiming to undo it", async () => {
  const f = await fixture(),
    input = f.create(),
    result = await f.write(input);
  expect(await f.write(input, "review")).toEqual(result);
  expect((await f.read()).equipment).toHaveLength(1);
});
it("records expired and overly distant requests without creating assets", async () => {
  const f = await fixture(),
    input = f.create();
  input.expiresAt = Date.now() - 1000;
  expect((await f.write(input)).outcome).toBe("expired");
  expect((await f.read()).equipment).toEqual([]);
  const future = f.create();
  future.expiresAt = Date.now() + 120_000;
  expect((await f.write(future)).outcome).toBe("expired");
});
it("binds each receipt to the exact account and input", async () => {
  const f = await fixture(),
    input = f.create();
  await f.write(input);
  const changed = structuredClone(input);
  if (changed.operation.kind !== "create") throw new Error("fixture");
  changed.operation.fields.name = "Another asset";
  await expect(f.write(changed)).rejects.toThrow("different asset change");
  await expect(
    f.write({ ...input, userId: crypto.randomUUID() }),
  ).rejects.toThrow("account changed");
  expect((await f.read()).equipment).toHaveLength(1);
});
it("does not read or change equipment in another organization", async () => {
  const f = await fixture(),
    other = await seedRelayMember(`foreign-assets-${crypto.randomUUID()}`);
  await expect(
    readEquipmentState(headers, other.orgId, env.DB),
  ).rejects.toThrow();
  await expect(
    f.write({ ...f.create(), orgId: other.orgId }),
  ).rejects.toThrow();
});
it("checks permission again at atomic admission, after preliminary authorization", async () => {
  const f = await fixture(),
    input = f.create();
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
    writeEquipmentCommand(headers, input, "write", db),
  ).rejects.toThrow("not confirmed");
  expect(
    (
      await env.DB.prepare("SELECT id FROM equipment WHERE orgId=?")
        .bind(f.actor.orgId)
        .all()
    ).results,
  ).toEqual([]);
  expect(
    await env.DB.prepare("SELECT id FROM app_setting WHERE orgId=? AND key=?")
      .bind(f.actor.orgId, `equipment-command:${input.requestId}`)
      .first(),
  ).toBeNull();
});
it("rolls back the receipt with a failed batch so the original request can retry", async () => {
  const f = await fixture(),
    input = f.create();
  const db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: <T>(statements: D1PreparedStatement[]) =>
      env.DB.batch<T>([
        ...statements,
        env.DB.prepare(
          "INSERT INTO equipment(id,orgId,name,category,updatedAt) VALUES(NULL,NULL,NULL,NULL,NULL)",
        ),
      ]),
  };
  await expect(
    writeEquipmentCommand(headers, input, "write", db),
  ).rejects.toThrow();
  expect((await f.read()).equipment).toEqual([]);
  expect((await f.write(input)).outcome).toBe("applied");
  expect((await f.read()).equipment).toHaveLength(1);
});
