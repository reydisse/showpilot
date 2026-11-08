import { z } from "zod";
import {
  replacementCopySchema,
  type ReplacementScope,
} from "./rundown-replacement-contract";
import { templateSaveCommandSchema } from "./template-save-contract";
import { readShowDetailsSnapshot } from "./show-details-write.server";
import { rundownDetailsAuthority } from "./rundown-details-authority.server";
import { RundownReplacementError } from "./rundown-replacement-write.server";
import { formatTimeInput, serviceTimeToIso } from "./utils";
type Database = Pick<D1Database, "prepare" | "batch">;
const templateSchema = templateSaveCommandSchema
  .pick({ serviceName: true, scheduledStartTime: true, items: true })
  .extend({ id: z.string(), name: z.string() })
  // Stored templates also carry creation/update metadata, unlike commands.
  .strip();
const previousSchema = z.object({
  name: z.string(),
  location: z.string(),
  scheduledStartTime: z.union([z.string(), z.number()]).nullable(),
});
export async function readRundownReplacement(
  db: Database,
  scope: ReplacementScope,
  actor: { sessionId: string; pin: string | null },
  live: { revision: number; stopped: boolean },
) {
  const { orgId, userId, showId, source } = scope;
  const access = await rundownDetailsAuthority(
    db,
    orgId,
    { userId, sessionId: actor.sessionId },
    actor.pin,
  );
  if (source.kind === "show" && source.id === showId)
    throw new RundownReplacementError("Choose a different previous show.");
  const target = (await readShowDetailsSnapshot(db, orgId, showId))?.snapshot;
  if (!target) throw new RundownReplacementError("This show was removed.");
  const timeZone =
    (
      await db
        .prepare(
          "SELECT value FROM app_setting WHERE orgId=? AND key='org-timezone'",
        )
        .bind(orgId)
        .first<{ value: string }>()
    )?.value ?? "UTC";
  let copy: z.infer<typeof replacementCopySchema>, label: string;
  if (source.kind === "template") {
    const stored = await db
      .prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
      .bind(orgId, `rundown-saved:${source.id}`)
      .first<{ value: string }>();
    if (!stored)
      throw new RundownReplacementError(
        "This template was removed. Refresh the list before choosing another copy.",
      );
    const value = templateSchema.parse(JSON.parse(stored.value));
    if (value.id !== source.id)
      throw new RundownReplacementError("This template cannot be loaded.");
    label = value.name;
    copy = replacementCopySchema.parse({
      serviceName: value.serviceName,
      location: target.location,
      scheduledStartTime: serviceTimeToIso(
        target.serviceDate,
        value.scheduledStartTime,
        timeZone,
      ),
      items: value.items,
    });
  } else {
    // One D1 batch gives the source metadata and rows a consistent snapshot.
    const [metadata, items] = await db.batch([
      db
        .prepare(
          "SELECT name,location,scheduledStartTime FROM rundown WHERE orgId=? AND id=? AND NOT EXISTS(SELECT 1 FROM app_setting WHERE orgId=rundown.orgId AND key='show-deleting:'||rundown.id)",
        )
        .bind(orgId, source.id),
      db
        .prepare(
          "SELECT itemId AS id,title,type,duration,notes,assignee,cue,sortOrder,hardStop,lowerThirdId FROM rundown_item WHERE orgId=? AND showId=? ORDER BY sortOrder",
        )
        .bind(orgId, source.id),
    ]);
    if (!metadata.results[0])
      throw new RundownReplacementError(
        "This previous show was removed. Refresh the list before choosing another copy.",
      );
    const value = previousSchema.parse(metadata.results[0]);
    label = value.name;
    const sourceStart =
      value.scheduledStartTime === null
        ? null
        : new Date(value.scheduledStartTime).toISOString();
    copy = replacementCopySchema.parse({
      serviceName: value.name,
      location: value.location,
      scheduledStartTime: serviceTimeToIso(
        target.serviceDate,
        formatTimeInput(sourceStart, timeZone),
        timeZone,
      ),
      items: items.results.map((input) => {
        const row = z.record(z.string(), z.unknown()).parse(input);
        return {
          ...row,
          hardStop: !!row.hardStop,
          lowerThirdId: row.lowerThirdId ?? undefined,
          status: "upcoming",
          actualStart: null,
          actualEnd: null,
        };
      }),
    });
  }
  if (
    !(await db
      .prepare(`SELECT 1 WHERE ${access.guard}`)
      .bind(...access.guardArgs)
      .first())
  )
    throw new RundownReplacementError(
      "Your rundown editing authority changed. Reopen this replacement.",
    );
  return {
    ...scope,
    serviceDate: target.serviceDate,
    expectedUpdatedAt: target.updatedAt,
    expectedRevision: live.revision,
    copy,
    label,
    timeZone,
    canReplace: live.stopped,
    targetName: target.name,
  };
}
