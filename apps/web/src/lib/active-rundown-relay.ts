import { rundownRelayKey } from "@/lib/rundown-relay-key";
import { getTodayDateString } from "@/lib/utils";

interface ShowRelayRow {
  id: string;
  serviceDate: string;
}

export function selectActiveShow(
  shows: ShowRelayRow[],
  today: string,
  activeShowId?: string,
  activeServiceDate?: string,
): ShowRelayRow | undefined {
  return (
    (activeShowId ? shows.find((show) => show.id === activeShowId) : undefined) ??
    (activeServiceDate
      ? shows.find((show) => show.serviceDate === activeServiceDate)
      : undefined) ??
    shows.find((show) => show.serviceDate >= today) ??
    shows.at(-1)
  );
}

/** Resolve external device/control traffic to the same show room as the UI. */
export async function getActiveRundownRelayTarget(
  db: D1Database,
  orgId: string,
): Promise<{ key: string; showId: string | null; serviceDate: string }> {
  const [showRows, settingRows] = await Promise.all([
    db
      .prepare(
        `SELECT id, serviceDate
           FROM rundown
          WHERE orgId = ?
          ORDER BY serviceDate ASC, scheduledStartTime ASC, createdAt ASC`,
      )
      .bind(orgId)
      .all<ShowRelayRow>(),
    db
      .prepare(
        `SELECT key, value
           FROM app_setting
          WHERE orgId = ?
            AND key IN ('active-show-id', 'active-service-date', 'org-timezone')`,
      )
      .bind(orgId)
      .all<{ key: string; value: string }>(),
  ]);
  const settings = Object.fromEntries(
    (settingRows.results ?? []).map((setting) => [setting.key, setting.value]),
  );
  const today = getTodayDateString(settings["org-timezone"] || undefined);
  const show = selectActiveShow(
    showRows.results ?? [],
    today,
    settings["active-show-id"],
    settings["active-service-date"],
  );
  const serviceDate = show?.serviceDate ?? settings["active-service-date"] ?? today;
  return {
    key: rundownRelayKey(orgId, serviceDate, today, show?.id),
    showId: show?.id ?? null,
    serviceDate,
  };
}
