import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AUTH_ORG_MODELS,
  FRESH_SESSION_MAX_AGE_MS,
  OrgDeletionAuthError,
  assertCanDeleteOrg,
  countOrgRows,
  deleteOrganizationCore,
  deriveOrgDeletionPlan,
  getRuntimeDataModel,
  type OrgDeletionTarget,
  type PrismaLikeForOrgDeletion,
  type RuntimeDataModelLike,
} from "../org-deletion-core";
import { ROLE_PERMISSIONS, type Role } from "../permissions";

// ─── Ground truth: parse prisma/schema.prisma ────────────────
// The deletion plan is derived from the generated client's runtime datamodel
// at runtime. These tests parse the schema file independently so the plan is
// verified against the actual schema, never a hand-maintained list.

const SCHEMA_PATH = path.resolve(__dirname, "../../../prisma/schema.prisma");
const SCHEMA_TEXT = readFileSync(SCHEMA_PATH, "utf8");

const SCALAR_TYPES = new Set([
  "String", "Int", "Float", "Boolean", "DateTime", "Json", "Bytes", "BigInt", "Decimal",
]);

interface ParsedRelation {
  field: string;
  type: string;
  fk: string | null; // fields: [..] when this side owns the FK
  isList: boolean;
}

interface ParsedModel {
  name: string;
  dbName: string | null;
  scalars: string[];
  relations: ParsedRelation[];
}

function parseSchema(text: string): Map<string, ParsedModel> {
  const models = new Map<string, ParsedModel>();
  for (const match of text.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    const model: ParsedModel = { name, dbName: null, scalars: [], relations: [] };
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      const mapMatch = line.match(/^@@map\("([^"]+)"\)/);
      if (mapMatch) {
        model.dbName = mapMatch[1];
        continue;
      }
      if (!line || line.startsWith("@@") || line.startsWith("//")) continue;
      const fieldMatch = line.match(/^(\w+)\s+(\w+)(\[\])?\??/);
      if (!fieldMatch) continue;
      const [, fieldName, fieldType, listMarker] = fieldMatch;
      if (SCALAR_TYPES.has(fieldType)) {
        model.scalars.push(fieldName);
      } else {
        const fkMatch = line.match(/@relation\(fields:\s*\[(\w+)\]/);
        model.relations.push({
          field: fieldName,
          type: fieldType,
          fk: fkMatch ? fkMatch[1] : null,
          isList: Boolean(listMarker),
        });
      }
    }
    models.set(name, model);
  }
  return models;
}

const parsedModels = parseSchema(SCHEMA_TEXT);

/** RuntimeDataModelLike built from the parsed schema (mirrors the generated client's shape). */
function schemaAsRuntimeDataModel(): RuntimeDataModelLike {
  const models: RuntimeDataModelLike["models"] = {};
  for (const m of parsedModels.values()) {
    models[m.name] = {
      dbName: m.dbName,
      fields: [
        ...m.scalars.map((name) => ({ name, kind: "scalar", type: "String" })),
        ...m.relations
          // Enum fields parse as relations to a non-model type — the real
          // datamodel reports them as kind "enum"; either way they are not
          // object relations, so drop them here.
          .filter((r) => parsedModels.has(r.type))
          .map((r) => ({ name: r.field, kind: "object", type: r.type })),
      ],
    };
  }
  return { models };
}

const dm = schemaAsRuntimeDataModel();
const plan = deriveOrgDeletionPlan(dm);

/** Models whose schema body declares a relation to Organization. */
const expectedOrgModels = [...parsedModels.values()]
  .filter((m) => m.name !== "Organization" && m.relations.some((r) => r.type === "Organization" && r.fk))
  .map((m) => m.name)
  .sort();

describe("deriveOrgDeletionPlan — derived from schema.prisma, not hand-maintained", () => {
  it("covers exactly the models that reference Organization", () => {
    expect(plan.map((t) => t.model).sort()).toEqual(expectedOrgModels);
  });

  it("uses each model's actual org FK column from its @relation(fields: [...])", () => {
    for (const target of plan) {
      const declaredFk = parsedModels
        .get(target.model)!
        .relations.find((r) => r.type === "Organization")!.fk;
      expect(target.orgField, target.model).toBe(declaredFk);
    }
  });

  it("uses each model's @@map table name", () => {
    for (const target of plan) {
      const mapped = parsedModels.get(target.model)!.dbName;
      expect(target.table, target.model).toBe(mapped ?? target.model);
    }
  });

  it("orders FK-owning children before their parents for every intra-plan relation", () => {
    const order = new Map(plan.map((t, i) => [t.model, i]));
    for (const target of plan) {
      for (const rel of parsedModels.get(target.model)!.relations) {
        if (rel.type === "Organization" || !rel.fk || !order.has(rel.type)) continue;
        expect(
          order.get(target.model)!,
          `${target.model} (references ${rel.type}) must be deleted before it`,
        ).toBeLessThan(order.get(rel.type)!);
      }
    }
  });

  it("excludes non-org-scoped models", () => {
    const planned = new Set(plan.map((t) => t.model));
    for (const name of ["User", "Session", "Account", "Verification", "PlatformSetting", "WaitlistSignup", "Organization"]) {
      expect(planned.has(name), name).toBe(false);
    }
  });

  it("fails closed when an org-referencing model has no recognizable FK column", () => {
    const broken: RuntimeDataModelLike = {
      models: {
        Mystery: {
          dbName: "mystery",
          fields: [
            { name: "id", kind: "scalar", type: "String" },
            { name: "ownerOrg", kind: "scalar", type: "String" },
            { name: "organization", kind: "object", type: "Organization" },
          ],
        },
      },
    };
    expect(() => deriveOrgDeletionPlan(broken)).toThrow(/refusing to delete/);
  });

  it("getRuntimeDataModel fails closed when the client does not expose a datamodel", () => {
    expect(() => getRuntimeDataModel({})).toThrow(/refusing to delete/);
  });
});

// ─── Authorization ───────────────────────────────────────────

const FRESH = new Date();
const STALE = new Date(Date.now() - FRESH_SESSION_MAX_AGE_MS - 1000);

const baseAuthInput = {
  sessionCreatedAt: FRESH,
  confirmName: "Grace Church",
  orgName: "Grace Church",
};

describe("assertCanDeleteOrg", () => {
  const nonOwnerRoles = (Object.keys(ROLE_PERMISSIONS) as Role[]).filter((r) => r !== "owner");

  it.each(nonOwnerRoles)("denies role %s (including directors)", (role) => {
    expect(() => assertCanDeleteOrg({ ...baseAuthInput, role })).toThrow(OrgDeletionAuthError);
  });

  it("denies a non-member (no role)", () => {
    expect(() => assertCanDeleteOrg({ ...baseAuthInput, role: null })).toThrow(OrgDeletionAuthError);
    expect(() => assertCanDeleteOrg({ ...baseAuthInput, role: undefined })).toThrow(OrgDeletionAuthError);
  });

  it("allows the owner with a fresh session and exact name", () => {
    expect(() => assertCanDeleteOrg({ ...baseAuthInput, role: "owner" })).not.toThrow();
  });

  it("denies the owner with a stale session", () => {
    expect(() =>
      assertCanDeleteOrg({ ...baseAuthInput, role: "owner", sessionCreatedAt: STALE }),
    ).toThrow(/recent sign-in/);
  });

  it("denies a wrong confirmation name", () => {
    expect(() =>
      assertCanDeleteOrg({ ...baseAuthInput, role: "owner", confirmName: "grace church" }),
    ).toThrow(/does not match/);
  });

  it("accepts a confirmation name with surrounding whitespace", () => {
    expect(() =>
      assertCanDeleteOrg({ ...baseAuthInput, role: "owner", confirmName: "  Grace Church  " }),
    ).not.toThrow();
  });
});

// ─── Execution against an in-memory fake Prisma ──────────────

type Row = Record<string, unknown>;

interface FakeDb {
  prisma: PrismaLikeForOrgDeletion;
  tables: Map<string, Row[]>; // keyed by delegate name
  log: string[];
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function createFakeDb(targets: OrgDeletionTarget[]): FakeDb {
  const tables = new Map<string, Row[]>();
  const log: string[] = [];

  const delegateFor = (name: string) => ({
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      log.push(`deleteMany:${name}`);
      const rows = tables.get(name) ?? [];
      const keep = rows.filter((r) => !matches(r, where));
      tables.set(name, keep);
      return { count: rows.length - keep.length };
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      (tables.get(name) ?? []).filter((r) => matches(r, where)).length,
  });

  const client: Record<string, unknown> = {
    // The core derives its table list from the client's runtime datamodel,
    // exactly as it does against the real generated client.
    _runtimeDataModel: dm,
    $transaction: async (ops: unknown[]) => {
      log.push("$transaction");
      return Promise.all(ops as Promise<unknown>[]);
    },
  };

  for (const t of targets) {
    tables.set(t.delegate, []);
    client[t.delegate] = delegateFor(t.delegate);
  }

  tables.set("organization", []);
  client.organization = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      (tables.get("organization") ?? []).find((r) => r.id === where.id) ?? null,
    deleteMany: async ({ where }: { where: { id: string } }) => {
      log.push("deleteMany:organization");
      const rows = tables.get("organization") ?? [];
      const keep = rows.filter((r) => r.id !== where.id);
      tables.set("organization", keep);
      return { count: rows.length - keep.length };
    },
  };

  tables.set("session", []);
  client.session = {
    updateMany: async ({
      where,
      data,
    }: {
      where: { activeOrganizationId: string };
      data: { activeOrganizationId: null };
    }) => {
      log.push("updateMany:session");
      let count = 0;
      for (const row of tables.get("session") ?? []) {
        if (row.activeOrganizationId === where.activeOrganizationId) {
          row.activeOrganizationId = data.activeOrganizationId;
          count++;
        }
      }
      return { count };
    },
  };

  return { prisma: client as unknown as PrismaLikeForOrgDeletion, tables, log };
}

const ORG_A = "org_a";
const ORG_B = "org_b";
const ROWS_PER_TABLE = 2;

function seed(db: FakeDb, opts: { stripeSubForA?: string | null } = {}) {
  for (const t of plan) {
    const rows = db.tables.get(t.delegate)!;
    for (const orgId of [ORG_A, ORG_B]) {
      for (let i = 0; i < ROWS_PER_TABLE; i++) {
        rows.push({ id: `${t.delegate}_${orgId}_${i}`, [t.orgField]: orgId });
      }
    }
  }
  db.tables.get("organization")!.push(
    { id: ORG_A, name: "Org A", stripeSubscriptionId: opts.stripeSubForA ?? null },
    { id: ORG_B, name: "Org B", stripeSubscriptionId: "sub_b" },
  );
  db.tables.get("session")!.push(
    { id: "sess_a", activeOrganizationId: ORG_A },
    { id: "sess_b", activeOrganizationId: ORG_B },
  );
}

function makeDeps(db: FakeDb, overrides: Partial<Parameters<typeof deleteOrganizationCore>[0]> = {}) {
  return {
    prisma: db.prisma,
    orgId: ORG_A,
    cancelStripeSubscription: async (id: string) => {
      db.log.push(`stripe:cancel:${id}`);
    },
    deleteR2Prefix: async (orgId: string) => {
      db.log.push(`r2:delete:${orgId}`);
      return 0;
    },
    ...overrides,
  };
}

describe("deleteOrganizationCore", () => {
  let db: FakeDb;

  beforeEach(() => {
    db = createFakeDb(plan);
  });

  it("deletes every org A row and touches zero rows of org B (cross-org isolation)", async () => {
    seed(db);
    const result = await deleteOrganizationCore(makeDeps(db));

    expect(result.alreadyDeleted).toBe(false);
    for (const t of plan) {
      const rows = db.tables.get(t.delegate)!;
      expect(rows.filter((r) => r[t.orgField] === ORG_A), `${t.model} org A`).toHaveLength(0);
      expect(rows.filter((r) => r[t.orgField] === ORG_B), `${t.model} org B`).toHaveLength(ROWS_PER_TABLE);
    }
    const orgs = db.tables.get("organization")!;
    expect(orgs.find((r) => r.id === ORG_A)).toBeUndefined();
    expect(orgs.find((r) => r.id === ORG_B)).toBeDefined();

    const sessions = db.tables.get("session")!;
    expect(sessions.find((s) => s.id === "sess_a")!.activeOrganizationId).toBeNull();
    expect(sessions.find((s) => s.id === "sess_b")!.activeOrganizationId).toBe(ORG_B);
  });

  it("cancels the Stripe subscription before deleting any rows", async () => {
    seed(db, { stripeSubForA: "sub_a" });
    await deleteOrganizationCore(makeDeps(db));

    const stripeIndex = db.log.indexOf("stripe:cancel:sub_a");
    const firstDelete = db.log.findIndex((l) => l.startsWith("deleteMany:"));
    expect(stripeIndex).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(stripeIndex).toBeLessThan(firstDelete);
  });

  it("aborts before deleting anything when Stripe cancellation fails", async () => {
    seed(db, { stripeSubForA: "sub_a" });
    await expect(
      deleteOrganizationCore(
        makeDeps(db, {
          cancelStripeSubscription: async () => {
            throw new Error("stripe down");
          },
        }),
      ),
    ).rejects.toThrow("stripe down");

    expect(db.log.some((l) => l.startsWith("deleteMany:"))).toBe(false);
    expect(db.tables.get("organization")!).toHaveLength(2);
  });

  it("skips Stripe when the org has no subscription", async () => {
    seed(db, { stripeSubForA: null });
    const result = await deleteOrganizationCore(makeDeps(db));
    expect(result.stripeSubscriptionCancelled).toBe(false);
    expect(db.log.some((l) => l.startsWith("stripe:"))).toBe(false);
  });

  it("deletes Better Auth member/invitation rows only in the final step, after R2", async () => {
    seed(db);
    await deleteOrganizationCore(makeDeps(db));
    const r2Index = db.log.indexOf(`r2:delete:${ORG_A}`);
    for (const model of AUTH_ORG_MODELS) {
      const delegate = model.charAt(0).toLowerCase() + model.slice(1);
      expect(db.log.indexOf(`deleteMany:${delegate}`)).toBeGreaterThan(r2Index);
    }
    expect(db.log.indexOf("deleteMany:organization")).toBeGreaterThan(r2Index);
  });

  it("is idempotent: a second run reports alreadyDeleted and calls nothing", async () => {
    seed(db, { stripeSubForA: "sub_a" });
    await deleteOrganizationCore(makeDeps(db));
    db.log.length = 0;

    const second = await deleteOrganizationCore(makeDeps(db));
    expect(second.alreadyDeleted).toBe(true);
    expect(db.log.filter((l) => l !== "$transaction")).toHaveLength(0);

    // Org B untouched throughout.
    for (const t of plan) {
      expect(
        db.tables.get(t.delegate)!.filter((r) => r[t.orgField] === ORG_B),
      ).toHaveLength(ROWS_PER_TABLE);
    }
  });

  it("is resumable: a failure mid-run (R2) leaves the org row intact and a re-run completes", async () => {
    seed(db);
    let failR2 = true;
    const deps = makeDeps(db, {
      deleteR2Prefix: async (orgId: string) => {
        if (failR2) throw new Error("r2 down");
        db.log.push(`r2:delete:${orgId}`);
        return 0;
      },
    });

    await expect(deleteOrganizationCore(deps)).rejects.toThrow("r2 down");
    // App rows are gone but the org row remains — the run is resumable.
    expect(db.tables.get("organization")!.find((r) => r.id === ORG_A)).toBeDefined();

    failR2 = false;
    const result = await deleteOrganizationCore(deps);
    expect(result.alreadyDeleted).toBe(false);
    expect(db.tables.get("organization")!.find((r) => r.id === ORG_A)).toBeUndefined();
    for (const t of plan) {
      expect(
        db.tables.get(t.delegate)!.filter((r) => r[t.orgField] === ORG_B),
        `${t.model} org B`,
      ).toHaveLength(ROWS_PER_TABLE);
    }
  });

  it("countOrgRows reports per-table counts for the dry run", async () => {
    seed(db);
    const counts = await countOrgRows(db.prisma, ORG_A);
    const orgRow = counts.find((c) => c.table === "organization");
    expect(orgRow?.rows).toBe(1);
    for (const t of plan) {
      expect(counts.find((c) => c.model === t.model)?.rows, t.model).toBe(ROWS_PER_TABLE);
    }
  });
});
