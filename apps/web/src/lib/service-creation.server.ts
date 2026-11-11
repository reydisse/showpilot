import { getPrisma } from "./db";
import { getD1 } from "./d1";
import { getAuth } from "./auth";
import { memberPermissionGuard } from "./member-permission-guard.server";
import { markDatabaseWrite } from "./request-database.server";
import { checkPlanLimit, PLAN_LIMITS } from "./plan-limits";
import { getRundownStateForOrg, normalizeLegacyRundownItems } from "./rundown";
import { readShowInventoryItem } from "./show-inventory";
import { serviceTimeToIso } from "./utils";
import {
  createShowInputSchema,
  showCreationFingerprint,
  type CreateServiceForOrgInput,
} from "./show-creation-contract";
import type { RundownItem } from "@/types/rundown";
export type { CreateServiceForOrgInput } from "./show-creation-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
type Receipt = {
  actorId: string;
  fingerprint: string;
  serviceDate: string;
  cancelledAt: number | null;
};

/** Both web and native creation commit the show, seed and receipt together.
 * Retry reads the receipt before mutable source material or current show details. */
export async function createServiceForOrg(
  input: CreateServiceForOrgInput,
  headers: Headers,
  db: Database = getD1(),
) {
  const data = createShowInputSchema.parse(input);
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || (data.userId && data.userId !== session.user.id))
    throw new Error(
      "Your account changed. Reopen this form before creating a show.",
    );
  const actorId = session.user.id,
    orgId = data.orgId;
  const access = await memberPermissionGuard(
    db,
    orgId,
    { userId: actorId, sessionId: session.session.id },
    ["schedule:manage"],
  );
  const requestId = data.requestId ?? crypto.randomUUID();
  const fingerprint = showCreationFingerprint(data);
  const read = `SELECT actorId,fingerprint,serviceDate,cancelledAt FROM show_creation_request
    WHERE orgId=? AND requestId=? AND ${access.guard}`;
  const readArgs = [orgId, requestId, ...access.guardArgs];
  let receipt = await db
    .prepare(read)
    .bind(...readArgs)
    .first<Receipt>();
  if (!receipt) {
    const prisma = getPrisma();
    const timezone =
      (
        await prisma.appSetting.findUnique({
          where: { orgId_key: { orgId, key: "org-timezone" } },
          select: { value: true },
        })
      )?.value ?? "";
    const inventory = data.inventoryId
      ? await readShowInventoryItem(orgId, data.inventoryId)
      : null;
    if (data.inventoryId && !inventory)
      throw new Error("Show inventory item not found");
    let items: RundownItem[] = [];
    let sourceShowId: string | undefined;
    if (inventory) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inventory.rundownJson);
      } catch {
        throw new Error(
          "The inventory rundown could not be read. Review that inventory item before trying again.",
        );
      }
      if (!Array.isArray(parsed))
        throw new Error(
          "The inventory rundown is invalid. Review it before trying again.",
        );
      items = normalizeLegacyRundownItems(parsed);
      if (items.length !== parsed.length)
        throw new Error(
          "The inventory rundown contains invalid items. Review it before trying again.",
        );
    } else if (data.copyFrom) {
      const source = await getRundownStateForOrg({
        orgId,
        serviceDate: data.copyFrom,
        showId: data.copyFromShowId,
      });
      sourceShowId = source.meta?.showId;
      if (!sourceShowId) throw new Error("Source show not found");
      items = source.items;
    }
    const start = serviceTimeToIso(
      data.serviceDate,
      data.startTime || inventory?.defaultStartTime || "",
      (data.startTime ? data.timeZone : undefined) || timezone || undefined,
    );
    const call = serviceTimeToIso(
      data.serviceDate,
      data.callTime || "",
      data.timeZone || timezone || undefined,
    );
    const nonce = crypto.randomUUID();
    const owns = "r.orgId=? AND r.requestId=? AND r.nonce=?";
    const ownsArgs = [orgId, requestId, nonce];
    const sourceGuard = inventory
      ? "EXISTS(SELECT 1 FROM show_inventory_item WHERE orgId=? AND id=? AND archivedAt IS NULL)"
      : sourceShowId
        ? "EXISTS(SELECT 1 FROM rundown WHERE orgId=? AND id=? AND serviceDate=?)"
        : "1";
    const sourceArgs = inventory
      ? [orgId, inventory.id]
      : sourceShowId
        ? [orgId, sourceShowId, data.copyFrom!]
        : [];
    // Count and current paid/trial entitlement are evaluated inside the write,
    // so concurrent creators cannot both take the final available slot.
    const capacity = `(SELECT CASE
      WHEN betaTester=1 AND (julianday((SELECT value FROM platform_setting WHERE key='publicLaunchDate')) IS NULL
        OR julianday((SELECT value FROM platform_setting WHERE key='publicLaunchDate'))>julianday('now')) THEN ?
      WHEN (CASE WHEN typeof(trialEndsAt) IN ('integer','real') THEN julianday(trialEndsAt/1000.0,'unixepoch') ELSE julianday(trialEndsAt) END)>julianday('now') THEN ?
      WHEN plan='pro' AND (subscriptionStatus IS NULL OR subscriptionStatus IN ('active','trialing','past_due')) THEN ?
      WHEN plan='starter' AND (subscriptionStatus IS NULL OR subscriptionStatus IN ('active','trialing','past_due')) THEN ?
      ELSE ? END FROM organization WHERE id=?)`;
    markDatabaseWrite();
    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO show_creation_request(orgId,requestId,actorId,fingerprint,nonce,serviceDate,createdAt)
        SELECT ?,?,?,?,?,?,? WHERE ${access.guard} AND ${sourceGuard}
          AND COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'),'')=?
          AND NOT EXISTS(SELECT 1 FROM rundown WHERE id=?)
          AND (SELECT COUNT(*) FROM rundown WHERE orgId=?)<${capacity}
        ON CONFLICT(orgId,requestId) DO NOTHING`,
        )
        .bind(
          orgId,
          requestId,
          actorId,
          fingerprint,
          nonce,
          data.serviceDate,
          Date.now(),
          ...access.guardArgs,
          ...sourceArgs,
          orgId,
          timezone,
          requestId,
          orgId,
          PLAN_LIMITS.pro.shows,
          PLAN_LIMITS.pro.shows,
          PLAN_LIMITS.pro.shows,
          PLAN_LIMITS.starter.shows,
          PLAN_LIMITS.free.shows,
          orgId,
        ),
      db
        .prepare(
          `INSERT INTO rundown(id,orgId,serviceDate,name,scheduledStartTime,scheduledCallTime,location,status,createdAt,updatedAt)
        SELECT ?,?,?,?,?,?,?,'stopped',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM show_creation_request r WHERE ${owns}`,
        )
        .bind(
          requestId,
          orgId,
          data.serviceDate,
          data.name || inventory?.name || "",
          start,
          call,
          data.location || inventory?.location || "",
          ...ownsArgs,
        ),
      db
        .prepare(
          `INSERT INTO rundown_item(id,orgId,showId,serviceDate,itemId,title,type,duration,notes,assignee,cue,status,sortOrder,
        hardStop,lowerThirdId,scheduledStart,expectedEnd,actualStart,actualEnd,createdAt,updatedAt)
        SELECT lower(hex(randomblob(16))),r.orgId,r.requestId,r.serviceDate,r.requestId||'-'||j.key,
          json_extract(j.value,'$.title'),json_extract(j.value,'$.type'),json_extract(j.value,'$.duration'),
          json_extract(j.value,'$.notes'),json_extract(j.value,'$.assignee'),json_extract(j.value,'$.cue'),'upcoming',j.key,
          json_extract(j.value,'$.hardStop'),json_extract(j.value,'$.lowerThirdId'),NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        FROM show_creation_request r,json_each(?) j WHERE ${owns}`,
        )
        .bind(JSON.stringify(items), ...ownsArgs),
      db
        .prepare(
          `INSERT INTO app_setting(id,orgId,key,value)
        SELECT ?,r.orgId,'rundown-items-storage:'||r.requestId,'rows-v1' FROM show_creation_request r WHERE ${owns}`,
        )
        .bind(crypto.randomUUID(), ...ownsArgs),
      db.prepare(read).bind(...readArgs),
    ]);
    receipt = (result[4].results[0] as Receipt | undefined) ?? null;
    if (!receipt) {
      await checkPlanLimit(
        orgId,
        "shows",
        await prisma.rundown.count({ where: { orgId } }),
      );
      throw new Error(
        "Show creation was not accepted. Your permission, timezone or source show may have changed. Review the form and retry.",
      );
    }
  }
  if (receipt.actorId !== actorId || receipt.fingerprint !== fingerprint)
    throw new Error(
      "This creation request was already used with a different account or details.",
    );
  if (receipt.cancelledAt !== null)
    throw new Error(
      "This creation request was cancelled during review. Submit the reviewed form as a new request.",
    );
  const existing = await db
    .prepare(
      `SELECT id FROM rundown WHERE orgId=? AND id=? AND ${access.guard}`,
    )
    .bind(orgId, requestId, ...access.guardArgs)
    .first();
  if (!existing) {
    // Distinguish removal from revocation without granting either a new write.
    await memberPermissionGuard(
      db,
      orgId,
      { userId: actorId, sessionId: session.session.id },
      ["schedule:manage"],
    );
    throw new Error(
      "This show was created and later removed. This retry will not recreate it.",
    );
  }
  return {
    ok: true as const,
    showId: requestId,
    serviceDate: receipt.serviceDate,
  };
}
