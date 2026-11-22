import type React from "react";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import {
  useShowCreation,
  type OpenCreatedShow,
  type ShowCreationScope,
} from "@/hooks/useShowCreation";
import { CreationRecovery } from "./CreationRecovery";
import { formatTimeInput, serviceTimeToIso } from "@/lib/utils";
import { modalCancel, modalFooter, modalPrimary } from "@/components/schedule/modal-a";
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
export type CreationShow = { id: string; serviceDate: string; name: string; meta?: string };
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
  variant = "default",
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
  /** "modal": Schedule — A layout (source choice cards, paired fields, Cancel/Create footer). */
  variant?: "default" | "modal";
}) {
  const modal = variant === "modal";
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
        {modal ? (
          <div role="radiogroup" aria-label="Start from" className="flex flex-col gap-2">
            <span className="text-xs font-medium text-[var(--sa-ink-2)]">Start from</span>
            {([
              { key: "", title: "Blank show", meta: "Name, time and venue only", pick: () => change("source", { kind: "blank" }) },
              ...shows.map((show) => ({ key: `show:${show.id}`, title: show.name || "Show", meta: show.meta ?? show.serviceDate, pick: () => change("source", { kind: "show", id: show.id, serviceDate: show.serviceDate, name: show.name }) })),
              ...inventory.map((item) => ({ key: `inventory:${item.id}`, title: item.name, meta: [`${item.itemCount} rundown ${item.itemCount === 1 ? "item" : "items"}`, item.defaultStartTime, item.location].filter(Boolean).join(" · "), pick: () => work.setDraft((current) => inventoryDraft(current, item, venueTimeZone)) })),
            ]).map((option) => {
              const active = option.key === selected;
              return (
                <button key={option.key || "blank"} type="button" role="radio" aria-checked={active} onClick={option.pick}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${active ? "border-fire-500 bg-fire-500/10" : "border-[var(--sa-border-strong)] bg-[var(--sa-surface)] hover:bg-[var(--sa-surface-2)]"}`}>
                  <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${active ? "shadow-[inset_0_0_0_1.5px_var(--color-fire-500)]" : "shadow-[inset_0_0_0_1.5px_var(--sa-border-strong)]"}`}>{active ? <span className="h-2 w-2 rounded-full bg-fire-500" /> : null}</span>
                  <span className="flex min-w-0 flex-col gap-0.5"><span className="truncate text-[13px] font-medium text-board-text">{option.title}</span><span className="truncate text-xs text-[var(--sa-ink-3)]">{option.meta}</span></span>
                </button>
              );
            })}
          </div>
        ) : (
        <label className="block text-sm text-board-muted">
          Start from a saved show
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
        )}
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
            <DateTimePicker
              kind="date"
              required
              min={minDate}
              className={control}
              value={draft.serviceDate}
              onValueChange={(value) => change("serviceDate", value)}
            />
          </label>
          <label className="block min-w-0 text-sm text-board-muted">
            Start time
            <DateTimePicker
              kind="time"
              required={requireStart}
              className={control}
              value={draft.startTime}
              onValueChange={(value) => change("startTime", value)}
            />
          </label>
        </div>
        <Pair modal={modal}>
        <label className="block min-w-0 text-sm text-board-muted">
          Crew call {modal ? "(optional)" : "time (optional)"}
          <DateTimePicker
            kind="time"
            className={control}
            value={draft.callTime}
            onValueChange={(value) => change("callTime", value)}
          />
        </label>
        {modal ? null : <p className="text-xs text-board-muted">
          Times use {draft.timeZone}. Leave crew call blank to use the
          organization default.
        </p>}
        <label className="block min-w-0 text-sm text-board-muted">
          Venue or location
          <input
            className={control}
            value={draft.location}
            maxLength={240}
            onChange={(e) => change("location", e.target.value)}
          />
        </label>
        </Pair>

      </fieldset>
      <CreationRecovery work={work} />
      {modal ? (
        <div className={modalFooter}>
          {onClose && <button type="button" className={modalCancel} onClick={onClose}>Cancel</button>}
          {!work.attempt && <button type="submit" disabled={!draft.serviceDate || (requireStart && !draft.startTime)} className={modalPrimary}>{createLabel}</button>}
        </div>
      ) : <div className="flex flex-wrap gap-2">
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
      </div>}
    </form>
  );
}

function Pair({ modal, children }: { modal: boolean; children: React.ReactNode }) {
  return modal ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">{children}</div> : <>{children}</>;
}
