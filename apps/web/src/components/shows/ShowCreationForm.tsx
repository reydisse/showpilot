import {
  useShowCreation,
  type OpenCreatedShow,
  type ShowCreationScope,
} from "@/hooks/useShowCreation";
import { CreationRecovery } from "./CreationRecovery";
import { formatTimeInput, serviceTimeToIso } from "@/lib/utils";
export type ShowSource =
  | { kind: "blank" }
  | { kind: "show"; id: string; serviceDate: string; name: string }
  | { kind: "inventory"; id: string; name: string };
export type ShowDraft = {
  serviceDate: string;
  name: string;
  startTime: string;
  callTime: string;
  location: string;
  timeZone: string;
  source: ShowSource;
};
export type CreationInventory = {
  id: string;
  name: string;
  location: string;
  defaultStartTime: string | null;
  itemCount: number;
};
export type CreationShow = { id: string; serviceDate: string; name: string };
export function inventoryDraft(
  draft: ShowDraft,
  item: CreationInventory,
  venueTimeZone: string,
): ShowDraft {
  const time = item.defaultStartTime
    ? formatTimeInput(
        serviceTimeToIso(
          draft.serviceDate,
          item.defaultStartTime,
          venueTimeZone,
        ),
        draft.timeZone,
      )
    : draft.startTime;
  return {
    ...draft,
    source: { kind: "inventory", id: item.id, name: item.name },
    name: item.name,
    location: item.location,
    startTime: time,
  };
}
const control =
  "min-h-11 w-full min-w-0 rounded-lg border border-board-border bg-board-bg px-3 py-2 text-sm text-board-text outline-none focus:border-fire-500";
const sourceKey = (source: ShowSource) =>
  source.kind === "blank" ? "" : `${source.kind}:${source.id}`;
export function ShowCreationForm({
  scope,
  initial,
  shows = [],
  inventory = [],
  venueTimeZone = "UTC",
  onCreated,
  beforeCreate,
  onClose,
  requireStart = false,
  minDate,
  createLabel = "Create show",
}: {
  scope: ShowCreationScope;
  initial: ShowDraft;
  shows?: CreationShow[];
  inventory?: CreationInventory[];
  venueTimeZone?: string;
  onCreated: OpenCreatedShow;
  beforeCreate?: (signal: AbortSignal) => Promise<void>;
  onClose?: () => void;
  requireStart?: boolean;
  minDate?: string;
  createLabel?: string;
}) {
  const work = useShowCreation(scope, initial, { onCreated, beforeCreate });
  const draft = work.draft;
  const change = <K extends keyof ShowDraft>(key: K, value: ShowDraft[K]) =>
    work.setDraft((current) => ({ ...current, [key]: value }));
  const selected = sourceKey(draft.source);
  const known =
    draft.source.kind === "blank" ||
    (draft.source.kind === "show" ? shows : inventory).some(
      (item) => `${draft.source.kind}:${item.id}` === selected,
    );
  return (
    <form
      className="space-y-4 min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        work.submit({
          orgId: scope.orgId,
          serviceDate: draft.serviceDate,
          name: draft.name,
          location: draft.location,
          timeZone: draft.timeZone,
          startTime: draft.startTime || undefined,
          callTime: draft.callTime || undefined,
          ...(draft.source.kind === "show"
            ? {
                copyFrom: draft.source.serviceDate,
                copyFromShowId: draft.source.id,
              }
            : draft.source.kind === "inventory"
              ? { inventoryId: draft.source.id }
              : {}),
        });
      }}
    >
      <fieldset
        disabled={work.locked}
        className="min-w-0 space-y-3 disabled:opacity-70"
      >
        <label className="block text-sm text-board-muted">
          Show name
          <input
            autoFocus
            className={control}
            value={draft.name}
            maxLength={120}
            onChange={(e) => change("name", e.target.value)}
            placeholder="Evening show, rehearsal, conference session…"
          />
        </label>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block min-w-0 text-sm text-board-muted">
            Date
            <input
              type="date"
              required
              min={minDate}
              className={control}
              value={draft.serviceDate}
              onChange={(e) => change("serviceDate", e.target.value)}
            />
          </label>
          <label className="block min-w-0 text-sm text-board-muted">
            Start time
            <input
              type="time"
              required={requireStart}
              className={control}
              value={draft.startTime}
              onChange={(e) => change("startTime", e.target.value)}
            />
          </label>
        </div>
        <label className="block text-sm text-board-muted">
          Crew call time (optional)
          <input
            type="time"
            className={control}
            value={draft.callTime}
            onChange={(e) => change("callTime", e.target.value)}
          />
        </label>
        <p className="text-xs text-board-muted">
          Times use {draft.timeZone}. Leave crew call blank to use the
          organization default.
        </p>
        <label className="block text-sm text-board-muted">
          Venue or location
          <input
            className={control}
            value={draft.location}
            maxLength={240}
            onChange={(e) => change("location", e.target.value)}
          />
        </label>
        <label className="block text-sm text-board-muted">
          Rundown source
          <select
            className={control}
            value={selected}
            onChange={(e) => {
              const value = e.target.value;
              if (!value) {
                change("source", { kind: "blank" });
                return;
              }
              const show = shows.find((item) => `show:${item.id}` === value);
              if (show) {
                change("source", { kind: "show", ...show });
                return;
              }
              const item = inventory.find(
                (item) => `inventory:${item.id}` === value,
              );
              if (item)
                work.setDraft((current) =>
                  inventoryDraft(current, item, venueTimeZone),
                );
            }}
          >
            <option value="">Start blank</option>
            {!known && draft.source.kind !== "blank" && (
              <option value={selected}>
                {draft.source.name || "Previous selection"} (unavailable)
              </option>
            )}
            {shows.map((show) => (
              <option key={show.id} value={`show:${show.id}`}>
                {show.name || "Show"} · {show.serviceDate}
              </option>
            ))}
            {inventory.length > 0 && (
              <optgroup label="Show inventory">
                {inventory.map((item) => (
                  <option key={item.id} value={`inventory:${item.id}`}>
                    {item.name} · {item.itemCount} items
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
      </fieldset>
      <CreationRecovery work={work} />
      <div className="flex flex-wrap gap-2">
        {onClose && (
          <button
            type="button"
            className="min-h-11 rounded-lg border border-board-border px-4 py-2 text-sm text-board-muted"
            onClick={onClose}
          >
            Close
          </button>
        )}
        {!work.attempt && (
          <button
            type="submit"
            disabled={!draft.serviceDate || (requireStart && !draft.startTime)}
            className="min-h-11 flex-1 rounded-lg bg-fire-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"
          >
            {createLabel}
          </button>
        )}
      </div>
    </form>
  );
}
