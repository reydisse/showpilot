import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";
import { rundownRelayKey } from "@/lib/rundown-relay-key";
import { env } from "cloudflare:workers";

type PurgeShowRelay = (show: { orgId: string; showId: string; serviceDate: string }) => Promise<void>;

async function purgeShowRelay(show: { orgId: string; showId: string; serviceDate: string }) {
  const workerEnv = env as unknown as {
    BETTER_AUTH_SECRET?: string;
    RUNDOWN_RELAY?: DurableObjectNamespace;
  };
  if (!workerEnv.BETTER_AUTH_SECRET || !workerEnv.RUNDOWN_RELAY) {
    throw new Error("Rundown relay deletion is not configured");
  }

  const roomKeys = [
    { key: rundownRelayKey(show.orgId, show.serviceDate, show.serviceDate, show.showId), force: true },
    { key: `${show.orgId}:${show.serviceDate}`, force: false },
    { key: show.orgId, force: false },
  ];
  for (const room of roomKeys) {
    const id = workerEnv.RUNDOWN_RELAY.idFromName(room.key);
    const url = new URL("https://rundown.internal/internal/purge-show");
    url.searchParams.set("orgId", show.orgId);
    url.searchParams.set("showId", show.showId);
    url.searchParams.set("serviceDate", show.serviceDate);
    if (room.force) url.searchParams.set("force", "1");
    const response = await workerEnv.RUNDOWN_RELAY.get(id).fetch(new Request(url, {
      method: "POST",
      headers: { "x-showpilot-internal-secret": workerEnv.BETTER_AUTH_SECRET },
    }));
    if (!response.ok) throw new Error("Could not retire the deleted show's live relay");
  }
}

/**
 * Remove one stopped show and every operational record owned by it.
 * Callers must authorize schedule management before invoking this function.
 */
export async function deleteServiceForOrg(
  input: { orgId: string; showId: string },
  purgeRelay: PurgeShowRelay = purgeShowRelay,
) {
  const prisma = getPrisma();
  const rundown = await prisma.rundown.findFirst({
    where: { id: input.showId, orgId: input.orgId },
    select: { id: true, serviceDate: true, status: true },
  });
  if (!rundown) throw new Error("Show not found");
  if (rundown.status === "live" || rundown.status === "running" || rundown.status === "paused") {
    throw new Error("Stop the show before deleting it");
  }

  const timerSettings = await prisma.appSetting.findMany({
    where: {
      orgId: input.orgId,
      key: { in: [`rundown-timer:${rundown.id}`, `rundown-timer:${rundown.serviceDate}`] },
    },
    select: { value: true },
  });
  for (const timerSetting of timerSettings) {
    try {
      const timer = JSON.parse(timerSetting.value) as { playback?: string } | null;
      if (timer?.playback === "play" || timer?.playback === "pause") {
        throw new Error("Stop the show before deleting it");
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Stop the show before deleting it") throw error;
    }
  }

  const db = getD1();
  const deletingKey = `show-deleting:${rundown.id}`;
  // Deny fresh relay traffic before closing existing clients. If cleanup
  // fails, this tombstone deliberately remains so the operation is resumable.
  await db.prepare(
    `INSERT INTO app_setting (id, orgId, key, value)
     VALUES (?, ?, ?, 'deleting')
     ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
  ).bind(crypto.randomUUID(), input.orgId, deletingKey).run();
  await purgeRelay({ orgId: input.orgId, showId: rundown.id, serviceDate: rundown.serviceDate });

  // Prisma and raw D1 share the same database, but separate calls are not one
  // transaction. Keep the complete row deletion in one atomic D1 batch.
  const showArgs = [input.orgId, rundown.id] as const;
  await db.batch([
    db.prepare("DELETE FROM content_reaction WHERE orgId = ? AND targetType = 'incident-comment' AND targetId IN (SELECT id FROM incident_comment WHERE orgId = ? AND incidentId IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?))").bind(input.orgId, input.orgId, ...showArgs),
    db.prepare("DELETE FROM incident_comment WHERE orgId = ? AND incidentId IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?)").bind(input.orgId, ...showArgs),
    db.prepare("DELETE FROM notification WHERE orgId = ? AND source IN (SELECT id FROM incident WHERE orgId = ? AND showId = ?)").bind(input.orgId, ...showArgs),
    db.prepare("DELETE FROM notification WHERE orgId = ? AND source IN (SELECT id FROM service_assignment WHERE orgId = ? AND showId = ?)").bind(input.orgId, ...showArgs),
    db.prepare("DELETE FROM cue_note WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM cue_sheet WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM checklist_entry WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM service_assignment WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM rundown_item WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM incident WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM mic_assignment WHERE orgId = ? AND showId = ?").bind(...showArgs),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?)").bind(
      input.orgId,
      `rundown-items:${rundown.id}`,
      `rundown-timer:${rundown.id}`,
      `rundown-message:${rundown.id}`,
      `rundown-ppslide:${rundown.id}`,
    ),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = 'active-show-id' AND value = ?").bind(input.orgId, rundown.id),
    db.prepare("DELETE FROM rundown WHERE orgId = ? AND id = ?").bind(...showArgs),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = ?").bind(input.orgId, deletingKey),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key IN (?, ?, ?, ?) AND NOT EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND serviceDate = ?)").bind(
      input.orgId,
      `rundown-items:${rundown.serviceDate}`,
      `rundown-timer:${rundown.serviceDate}`,
      `rundown-message:${rundown.serviceDate}`,
      `rundown-ppslide:${rundown.serviceDate}`,
      input.orgId,
      rundown.serviceDate,
    ),
    db.prepare("DELETE FROM app_setting WHERE orgId = ? AND key = 'active-service-date' AND value = ? AND NOT EXISTS (SELECT 1 FROM rundown WHERE orgId = ? AND serviceDate = ?)").bind(
      input.orgId,
      rundown.serviceDate,
      input.orgId,
      rundown.serviceDate,
    ),
  ]);

  return { ok: true as const };
}
