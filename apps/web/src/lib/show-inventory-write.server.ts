import { NEXT_UPDATED_AT_SQL } from "./sqlite-timestamp.server";
import { z } from "zod";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import { normalizeLegacyRundownItems } from "./rundown";
import {
  inventoryCommandSchema,
  inventoryFingerprint,
  inventoryItemSchema,
  type InventoryCommand,
  type InventoryResult,
} from "./show-inventory-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
const receiptSchema = z.object({
  actorId: z.string(),
  itemId: z.string(),
  fingerprint: z.string(),
  outcome: z.enum(["applied", "conflict", "cancelled", "removed"]),
  appliedVersion: z.string().nullable(),
});
const rawItemSchema = inventoryItemSchema.omit({ itemCount: true }).extend({
  rundownJson: z.string(),
  archivedAt: z.union([z.string(), z.number()]).nullable(),
  createdAt: z.union([z.string(), z.number()]),
  updatedAt: z.union([z.string(), z.number()]),
});
const sourceItems = z.array(
  z.object({ id: z.string(), title: z.string() }).passthrough(),
);
const templateSchema = z.union([sourceItems, z.object({ items: sourceItems })]);
const iso = (value: string | number) => new Date(value).toISOString();
async function readItem(db: Database, orgId: string, id: string) {
  const raw = await db
    .prepare(
      "SELECT id,name,description,location,defaultStartTime,sourceTemplateId,rundownJson,archivedAt,createdAt,updatedAt FROM show_inventory_item WHERE orgId=? AND id=?",
    )
    .bind(orgId, id)
    .first();
  if (!raw) return null;
  const row = rawItemSchema.parse(raw);
  let items: unknown;
  try {
    items = JSON.parse(row.rundownJson);
  } catch {
    items = null;
  }
  return {
    storedVersion: row.updatedAt,
    item: inventoryItemSchema.parse({
      ...row,
      itemCount: Array.isArray(items) ? items.length : 0,
      archivedAt: row.archivedAt === null ? null : iso(row.archivedAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    }),
  };
}

/** Receipt and inventory change commit together. Review fences an undelivered
 * request, and replay reads the receipt before any mutable template or row. */
export async function writeShowInventory(
  input: InventoryCommand,
  headers: Headers,
  mode: "apply" | "review" = "apply",
  db: Database = getD1(),
): Promise<{ result: InventoryResult; appliedNow: boolean }> {
  const command = inventoryCommandSchema.parse(input),
    { orgId, requestId, operation: op } = command;
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || (command.userId && command.userId !== session.user.id))
    throw new Error(
      "Your account changed. Reopen inventory before continuing.",
    );
  const actorId = session.user.id;
  const access = await memberPermissionGuard(
    db,
    orgId,
    { userId: actorId, sessionId: session.session.id },
    ["schedule:manage"],
  );
  const fingerprint = inventoryFingerprint(command),
    id = op.kind === "create" ? requestId : op.id;
  const read = `SELECT actorId,itemId,fingerprint,outcome,appliedVersion FROM show_inventory_request WHERE orgId=? AND requestId=? AND ${access.guard}`;
  const readArgs = [orgId, requestId, ...access.guardArgs];
  let raw: unknown = await db
      .prepare(read)
      .bind(...readArgs)
      .first(),
    appliedNow = false;
  if (!raw) {
    const nonce = crypto.randomUUID();
    const owns =
      "EXISTS(SELECT 1 FROM show_inventory_request WHERE orgId=? AND requestId=? AND nonce=? AND outcome='applied')";
    const ownsArgs = [orgId, requestId, nonce];
    let decision = "'cancelled'",
      decisionArgs: (string | number | null)[] = [],
      change: D1PreparedStatement | null = null;
    if (mode === "apply" && op.kind === "create") {
      let rundownJson = "[]",
        sourceGuard = "1",
        sourceArgs: (string | number | null)[] = [];
      if (op.sourceTemplateId) {
        const key = `rundown-saved:${op.sourceTemplateId}`;
        const template = await db
          .prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
          .bind(orgId, key)
          .first<{ value: string }>();
        if (!template)
          throw new Error(
            "Saved rundown template not found. Review this request before choosing another source.",
          );
        let parsed: unknown;
        try {
          parsed = JSON.parse(template.value);
        } catch {
          throw new Error(
            "This saved rundown cannot be read. Review the source before saving inventory.",
          );
        }
        const source = templateSchema.safeParse(parsed);
        if (!source.success)
          throw new Error(
            "This saved rundown contains invalid items. Review the source before saving inventory.",
          );
        const items = Array.isArray(source.data)
          ? source.data
          : source.data.items;
        rundownJson = JSON.stringify(
          normalizeLegacyRundownItems(items).map((item, index) => ({
            ...item,
            id: `${requestId}-item-${index}`,
            status: "upcoming",
            sortOrder: index,
            scheduledStart: null,
            expectedEnd: null,
            actualStart: null,
            actualEnd: null,
          })),
        );
        sourceGuard =
          "EXISTS(SELECT 1 FROM app_setting WHERE orgId=? AND key=? AND value=?)";
        sourceArgs = [orgId, key, template.value];
      }
      decision = `CASE WHEN NOT EXISTS(SELECT 1 FROM show_inventory_item WHERE id=?) AND ${sourceGuard} THEN 'applied' ELSE 'conflict' END`;
      decisionArgs = [id, ...sourceArgs];
      change = db
        .prepare(
          `INSERT INTO show_inventory_item(id,orgId,name,description,location,defaultStartTime,sourceTemplateId,rundownJson,createdAt,updatedAt)
        SELECT ?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${owns}`,
        )
        .bind(
          id,
          orgId,
          op.name,
          op.description,
          op.location,
          op.defaultStartTime || null,
          op.sourceTemplateId,
          rundownJson,
          ...ownsArgs,
        );
    } else if (mode === "apply" && op.kind === "archive") {
      const current = await readItem(db, orgId, id);
      const matches =
        current &&
        current.item.updatedAt === iso(op.expectedUpdatedAt) &&
        Boolean(current.item.archivedAt) !== op.archived;
      decision = `CASE WHEN NOT EXISTS(SELECT 1 FROM show_inventory_item WHERE orgId=? AND id=?) THEN 'removed'
        WHEN ?=1 AND EXISTS(SELECT 1 FROM show_inventory_item WHERE orgId=? AND id=? AND updatedAt=? AND (archivedAt IS NOT NULL)=?) THEN 'applied' ELSE 'conflict' END`;
      decisionArgs = [
        orgId,
        id,
        matches ? 1 : 0,
        orgId,
        id,
        current?.storedVersion ?? "",
        op.archived ? 0 : 1,
      ];
      change = db
        .prepare(
          `UPDATE show_inventory_item SET archivedAt=CASE WHEN ?=1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
        updatedAt=${NEXT_UPDATED_AT_SQL}
        WHERE orgId=? AND id=? AND ${owns}`,
        )
        .bind(op.archived ? 1 : 0, orgId, id, ...ownsArgs);
    }
    markDatabaseWrite();
    const statements = [
      db
        .prepare(
          `INSERT INTO show_inventory_request(orgId,requestId,actorId,itemId,fingerprint,nonce,outcome,createdAt)
      SELECT ?,?,?,?,?,?,${decision},? WHERE ${access.guard} ON CONFLICT(orgId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          requestId,
          actorId,
          id,
          fingerprint,
          nonce,
          ...decisionArgs,
          Date.now(),
          ...access.guardArgs,
        ),
    ];
    if (change) statements.push(change);
    statements.push(
      db
        .prepare(
          `UPDATE show_inventory_request SET appliedVersion=(SELECT updatedAt FROM show_inventory_item WHERE orgId=? AND id=?)
      WHERE orgId=? AND requestId=? AND nonce=? AND outcome='applied'`,
        )
        .bind(orgId, id, ...ownsArgs),
      db.prepare(read).bind(...readArgs),
    );
    const results = await db.batch(statements);
    raw = results.at(-1)?.results[0];
    appliedNow = results[0].meta.changes === 1 && change !== null;
    if (!raw)
      throw new Error(
        "The inventory request was not accepted. Check your access and retry or review it.",
      );
  }
  const receipt = receiptSchema.parse(raw);
  if (
    receipt.actorId !== actorId ||
    receipt.fingerprint !== fingerprint ||
    receipt.itemId !== id
  )
    throw new Error(
      "This inventory request belongs to another account or different details. The original item was not changed.",
    );
  const current = await readItem(db, orgId, id);
  const outcome =
    receipt.outcome !== "applied"
      ? receipt.outcome
      : !current
        ? "removed"
        : current.item.updatedAt !== receipt.appliedVersion
          ? "superseded"
          : "applied";
  return {
    result: { requestId, id, outcome, item: current?.item ?? null },
    appliedNow: appliedNow && receipt.outcome === "applied",
  };
}
