import { useEffect, useId, useState } from "react";

/** Search only filters choices; the Settings owner retains save/conflict/retry state. */
export function TimezoneSetting({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [zones, setZones] = useState<string[]>([]);
  // Use the browser's supported IANA catalog after hydration. Server and browser
  // ICU versions can differ; the saved value must still render on both.
  useEffect(() => {
    setZones(Intl.supportedValuesOf("timeZone"));
  }, []);
  const query = search.trim().toLowerCase().replaceAll("_", " ");
  const matches = [...new Set(["UTC", ...zones])].filter((zone) =>
    zone.replaceAll("_", " ").toLowerCase().includes(query),
  );
  const choices =
    value && !matches.includes(value) ? [value, ...matches] : matches;
  return (
    <div className="space-y-2">
      <label
        htmlFor={`${id}-search`}
        className="block text-sm text-board-muted"
      >
        Search timezones by city or region
      </label>
      <input
        id={`${id}-search`}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="min-h-11 w-full rounded-xl border border-board-border bg-board-bg px-3 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500"
      />
      <label htmlFor={`${id}-zone`} className="sr-only">
        Timezone
      </label>
      <select
        id={`${id}-zone`}
        aria-label="Timezone"
        aria-describedby={`${id}-hint`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full min-w-0 rounded-xl border border-board-border bg-board-bg px-3 text-sm text-board-text focus-visible:outline-2 focus-visible:outline-fire-500"
      >
        {!value && (
          <option value="" disabled>
            Not configured. Choose a timezone
          </option>
        )}
        {choices.map((zone) => (
          <option key={zone} value={zone}>
            {zone.replaceAll("_", " ")}
            {zone === value && query && !matches.includes(zone)
              ? " (current selection)"
              : ""}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className="text-xs text-board-muted">
        Choose the venue's timezone for show dates and times. Selecting a
        timezone saves it automatically.
      </p>
      {query && (
        <p role="status" className="text-xs text-board-muted">
          {matches.length
            ? `${matches.length} matching timezone${matches.length === 1 ? "" : "s"}.`
            : "No matching timezones. Clear or change your search; your selection is unchanged."}
        </p>
      )}
    </div>
  );
}
