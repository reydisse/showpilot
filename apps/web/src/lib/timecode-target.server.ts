import { getActiveRundownRelayTarget } from "./active-rundown-relay";
import { rundownRelayKey } from "./rundown-relay-key";

export interface TimecodeTarget {
  orgId: string;
  showId: string;
  serviceDate: string;
}

export function timecodeRelayKey(target: TimecodeTarget): string {
  return rundownRelayKey(target.orgId, target.serviceDate, "", target.showId);
}

/** Explicit identities never fall back to another organization's or active show. */
export async function resolveTimecodeTarget(db: D1Database, orgId: string, showId?: string | null): Promise<TimecodeTarget | null> {
  if (showId) {
    const row = await db.prepare(`SELECT r.id, r.serviceDate FROM rundown r WHERE r.orgId = ? AND r.id = ?
      AND NOT EXISTS (SELECT 1 FROM app_setting s WHERE s.orgId = r.orgId AND s.key = ?) LIMIT 1`)
      .bind(orgId, showId, `show-deleting:${showId}`).first<{ id: string; serviceDate: string }>();
    return row ? { orgId, showId: row.id, serviceDate: row.serviceDate } : null;
  }
  const active = await getActiveRundownRelayTarget(db, orgId);
  return active.showId ? resolveTimecodeTarget(db, orgId, active.showId) : null;
}

export function timecodeTargetUrl(target: TimecodeTarget, path: string): URL {
  const url = new URL(path, "https://timecode.internal");
  url.searchParams.set("orgId", target.orgId);
  url.searchParams.set("showId", target.showId);
  url.searchParams.set("serviceDate", target.serviceDate);
  return url;
}

export async function getShowTimecodeRelay(bindings: Pick<Cloudflare.Env, "TIMECODE_RELAY">, target: TimecodeTarget) {
  const stub = bindings.TIMECODE_RELAY.getByName(timecodeRelayKey(target));
  const result = await stub.bindShow(target, true);
  if (!result.ok) throw new Error(result.error);
  return stub;
}
