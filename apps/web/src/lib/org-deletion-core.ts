import { hasPermission, normalizeRole } from "./permissions";

// Core organization-deletion logic, shared by the deleteOrganization server
// function (Workers) and scripts/delete-org.ts (Node). This module must stay
// free of Workers-only imports (cloudflare:workers, better-auth, stripe).
//
// The most dangerous function in the app. Safety model:
//
// - The table list is DERIVED from the Prisma client's embedded runtime
//   datamodel (regenerated from schema.prisma by `pnpm db:generate`), never
//   hand-maintained. A new org-scoped model is picked up automatically; a
//   model whose org FK can't be identified makes derivation throw before
//   anything is deleted (fail closed).
// - D1 does not support real transactions — Prisma's D1 adapter runs
//   $transaction batches as sequential individual queries. Atomicity is
//   therefore approximated by (a) strict child-before-parent delete order,
//   so an interrupted run never leaves rows referencing deleted parents, and
//   (b) idempotency: every step is a no-op when its work is already done, so
//   a partial failure is safely re-runnable.
// - The organization row itself is deleted LAST; while it exists, a re-run
//   can always resume.

export interface RuntimeDataModelField {
  name: string;
  kind: string;
  type: string;
}

export interface RuntimeDataModelLike {
  models: Record<
    string,
    { dbName?: string | null; fields: RuntimeDataModelField[] }
  >;
}

/** One org-scoped model to wipe: Prisma delegate + SQL table + org FK column. */
export interface OrgDeletionTarget {
  model: string;
  delegate: string;
  table: string;
  orgField: string;
}

// Better Auth organization tables — deleted in the final step together with
// the organization row, after app data and R2 objects are gone.
export const AUTH_ORG_MODELS = ["Member", "Invitation"] as const;

/** How recent a session must be to authorize deletion (server-enforced). */
export const FRESH_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

const ORG_FK_CANDIDATES = ["orgId", "organizationId"] as const;

function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Read the runtime datamodel off a Prisma client instance. `_runtimeDataModel`
 * is internal API; if its shape ever changes we throw before deleting anything.
 */
export function getRuntimeDataModel(prisma: unknown): RuntimeDataModelLike {
  const dm = (prisma as { _runtimeDataModel?: RuntimeDataModelLike })
    ._runtimeDataModel;
  if (!dm || typeof dm.models !== "object" || dm.models === null) {
    throw new Error(
      "Could not read the Prisma runtime datamodel — refusing to delete (the org-deletion table list is derived from it)",
    );
  }
  return dm;
}

/**
 * Derive every model that references Organization, in child-before-parent
 * order. Throws if any org-scoped model's FK column can't be identified.
 */
export function deriveOrgDeletionPlan(
  dm: RuntimeDataModelLike,
): OrgDeletionTarget[] {
  const targets = new Map<string, OrgDeletionTarget>();

  for (const [model, def] of Object.entries(dm.models)) {
    if (model === "Organization") continue;
    const referencesOrg = def.fields.some(
      (f) => f.kind === "object" && f.type === "Organization",
    );
    if (!referencesOrg) continue;

    const scalarNames = new Set(
      def.fields.filter((f) => f.kind === "scalar").map((f) => f.name),
    );
    const fks = ORG_FK_CANDIDATES.filter((c) => scalarNames.has(c));
    if (fks.length !== 1) {
      throw new Error(
        `Model ${model} references Organization but its org FK column could not be identified ` +
          `(found: ${fks.join(", ") || "none"}) — refusing to delete`,
      );
    }

    targets.set(model, {
      model,
      delegate: lowerFirst(model),
      table: def.dbName || model,
      orgField: fks[0],
    });
  }

  return topoSortChildrenFirst(dm, [...targets.values()]);
}

/**
 * Order targets so that a model holding a FK to another target is deleted
 * first. FK ownership is detected by the schema-wide convention that the
 * relation field `foo` is backed by the scalar `fooId` (e.g. ChecklistEntry
 * has `template` + `templateId`). An unconventional relation produces no
 * edge; the per-table deletes would then hit a FK error and abort before the
 * parent row is touched — verified against schema.prisma by the test suite.
 */
function topoSortChildrenFirst(
  dm: RuntimeDataModelLike,
  targets: OrgDeletionTarget[],
): OrgDeletionTarget[] {
  const inPlan = new Set(targets.map((t) => t.model));
  // edges[parent] = children that must be deleted before it
  const childrenOf = new Map<string, Set<string>>();
  for (const t of targets) {
    const fields = dm.models[t.model].fields;
    const scalarNames = new Set(
      fields.filter((f) => f.kind === "scalar").map((f) => f.name),
    );
    for (const f of fields) {
      if (f.kind !== "object" || !inPlan.has(f.type) || f.type === t.model) continue;
      if (!scalarNames.has(`${f.name}Id`)) continue; // not the FK side
      const set = childrenOf.get(f.type) ?? new Set<string>();
      set.add(t.model);
      childrenOf.set(f.type, set);
    }
  }

  const ordered: OrgDeletionTarget[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const byModel = new Map(targets.map((t) => [t.model, t]));

  const place = (model: string) => {
    if (placed.has(model)) return;
    if (visiting.has(model)) {
      throw new Error(
        `Circular relation involving ${model} — cannot order org deletion, refusing to delete`,
      );
    }
    visiting.add(model);
    for (const child of childrenOf.get(model) ?? []) place(child);
    visiting.delete(model);
    placed.add(model);
    ordered.push(byModel.get(model)!);
  };

  for (const t of targets) place(t.model);
  return ordered;
}

// ─── Authorization (pure, unit-testable) ────────────────────

export class OrgDeletionAuthError extends Error {}

export function assertCanDeleteOrg(input: {
  role: string | null | undefined;
  sessionCreatedAt: Date | string;
  confirmName: string;
  orgName: string;
  now?: Date;
}): void {
  const role = normalizeRole(input.role);
  if (!role || !hasPermission(role, "org:delete")) {
    throw new OrgDeletionAuthError(
      "Only the organization owner can delete the organization",
    );
  }

  const createdAt = new Date(input.sessionCreatedAt).getTime();
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(createdAt) || now - createdAt > FRESH_SESSION_MAX_AGE_MS) {
    throw new OrgDeletionAuthError(
      "For security, deleting an organization requires a recent sign-in. Sign out, sign back in, and try again.",
    );
  }

  if (input.confirmName.trim() !== input.orgName) {
    throw new OrgDeletionAuthError(
      "Confirmation text does not match the organization name",
    );
  }
}

// ─── Execution ───────────────────────────────────────────────

interface DelegateLike {
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: { where: Record<string, unknown> }): Promise<number>;
}

export interface PrismaLikeForOrgDeletion {
  $transaction(ops: unknown[]): Promise<unknown>;
  organization: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; name: true; stripeSubscriptionId: true };
    }): Promise<{ id: string; name: string; stripeSubscriptionId: string | null } | null>;
    deleteMany(args: { where: { id: string } }): Promise<{ count: number }>;
  };
  session: {
    updateMany(args: {
      where: { activeOrganizationId: string };
      data: { activeOrganizationId: null };
    }): Promise<{ count: number }>;
  };
}

function delegates(prisma: PrismaLikeForOrgDeletion): Record<string, DelegateLike> {
  return prisma as unknown as Record<string, DelegateLike>;
}

export interface OrgDeletionResult {
  alreadyDeleted: boolean;
  stripeSubscriptionCancelled: boolean;
  r2ObjectsDeleted: number;
  deletedTables: string[];
}

export async function deleteOrganizationCore(opts: {
  prisma: PrismaLikeForOrgDeletion;
  orgId: string;
  /** Cancel the org's Stripe subscription. Must tolerate already-cancelled/missing. */
  cancelStripeSubscription: (subscriptionId: string) => Promise<void>;
  /** Delete all R2 objects under the org's prefix; returns count deleted. */
  deleteR2Prefix: (orgId: string) => Promise<number>;
}): Promise<OrgDeletionResult> {
  const { prisma, orgId } = opts;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, stripeSubscriptionId: true },
  });
  // Org row already gone — a previous run completed (or never existed).
  if (!org) {
    return {
      alreadyDeleted: true,
      stripeSubscriptionCancelled: false,
      r2ObjectsDeleted: 0,
      deletedTables: [],
    };
  }

  const plan = deriveOrgDeletionPlan(getRuntimeDataModel(prisma));
  const authModels = new Set<string>(AUTH_ORG_MODELS);
  const appTargets = plan.filter((t) => !authModels.has(t.model));
  const authTargets = plan.filter((t) => authModels.has(t.model));
  const d = delegates(prisma);

  // 1. Stripe first — never delete a paying org's data while its
  //    subscription would keep billing.
  let stripeSubscriptionCancelled = false;
  if (org.stripeSubscriptionId) {
    await opts.cancelStripeSubscription(org.stripeSubscriptionId);
    stripeSubscriptionCancelled = true;
  }

  // 2. App data, children before parents.
  await prisma.$transaction(
    appTargets.map((t) =>
      d[t.delegate].deleteMany({ where: { [t.orgField]: orgId } }),
    ),
  );

  // 3. R2 objects under the org's prefix.
  const r2ObjectsDeleted = await opts.deleteR2Prefix(orgId);

  // 4. Better Auth memberships/invitations, stale session pointers, then the
  //    organization row itself — last, so any earlier failure stays resumable.
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { activeOrganizationId: orgId },
      data: { activeOrganizationId: null },
    }),
    ...authTargets.map((t) =>
      d[t.delegate].deleteMany({ where: { [t.orgField]: orgId } }),
    ),
    prisma.organization.deleteMany({ where: { id: orgId } }),
  ]);

  return {
    alreadyDeleted: false,
    stripeSubscriptionCancelled,
    r2ObjectsDeleted,
    deletedTables: [...plan.map((t) => t.table), "organization"],
  };
}

/** Per-table row counts for an org — the dry-run output of scripts/delete-org.ts. */
export async function countOrgRows(
  prisma: PrismaLikeForOrgDeletion,
  orgId: string,
): Promise<Array<{ table: string; model: string; rows: number }>> {
  const plan = deriveOrgDeletionPlan(getRuntimeDataModel(prisma));
  const d = delegates(prisma);
  const counts = await Promise.all(
    plan.map(async (t) => ({
      table: t.table,
      model: t.model,
      rows: await d[t.delegate].count({ where: { [t.orgField]: orgId } }),
    })),
  );
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, name: true, stripeSubscriptionId: true },
  });
  counts.push({ table: "organization", model: "Organization", rows: org ? 1 : 0 });
  return counts;
}
