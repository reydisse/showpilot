import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ClockFormat = "12hr" | "24hr";

export function formatTime(
  date: Date,
  clockFormat: ClockFormat = "12hr",
  timeZone?: string,
): string {
  if (clockFormat === "24hr") {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timeZone ? { timeZone } : {}),
    });
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** Full clock with seconds — for timer kiosk top bar */
export function formatClockFull(
  date: Date,
  clockFormat: ClockFormat = "12hr",
  timeZone?: string,
): string {
  if (timeZone) {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: clockFormat !== "24hr",
      timeZone,
    });
  }
  if (clockFormat === "24hr") {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `${h}:${m}:${s}`;
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/** Returns today's date as YYYY-MM-DD string in the provided timezone when set. */
export function getTodayDateString(timeZone?: string): string {
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone,
      }).format(new Date());
    } catch {
      // Invalid timezone string: fall back to browser local timezone.
    }
  }

  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Format a stored instant as an HH:mm wall time in the organization's zone. */
export function formatTimeInput(
  value: string | Date | null | undefined,
  timeZone?: string,
): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (!timeZone) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    return hour && minute ? `${hour}:${minute}` : "";
  } catch {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
}

/** Format an HH:mm venue wall time for people without applying a device timezone. */
export function formatWallTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return "";
  return new Date(Date.UTC(2000, 0, 1, hour, minute)).toLocaleTimeString(
    "en-US",
    {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    },
  );
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
    ) - date.getTime()
  );
}

/** Convert a service-date wall time in the organization's zone to a stable ISO instant. */
export function serviceTimeToIso(
  serviceDate: string,
  time: string,
  timeZone?: string,
): string | null {
  if (!time) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const [year, month, day] = serviceDate.split("-").map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!year || !month || !day || hour > 23 || minute > 59) return null;
  if (!timeZone)
    return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
  try {
    const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const offsets = new Set<number>();
    for (let deltaHours = -24; deltaHours <= 24; deltaHours += 6) {
      offsets.add(
        timeZoneOffsetMs(
          new Date(wallClockUtc + deltaHours * 3_600_000),
          timeZone,
        ),
      );
    }
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const matches = [...offsets]
      .map((offset) => new Date(wallClockUtc - offset))
      .filter((candidate) => {
        const parts = Object.fromEntries(
          formatter
            .formatToParts(candidate)
            .map((part) => [part.type, part.value]),
        );
        return (
          Number(parts.year) === year &&
          Number(parts.month) === month &&
          Number(parts.day) === day &&
          Number(parts.hour) === hour &&
          Number(parts.minute) === minute
        );
      });
    const uniqueMatches = [
      ...new Map(
        matches.map((candidate) => [candidate.getTime(), candidate]),
      ).values(),
    ];
    if (uniqueMatches.length === 0) {
      throw new Error(
        `${time} does not exist on ${serviceDate} in ${timeZone} because the clock changes.`,
      );
    }
    if (uniqueMatches.length > 1) {
      throw new Error(
        `${time} occurs twice on ${serviceDate} in ${timeZone}. Choose a different time to avoid ambiguity.`,
      );
    }
    return uniqueMatches[0].toISOString();
  } catch (error) {
    if (
      error instanceof Error &&
      /does not exist|occurs twice/.test(error.message)
    )
      throw error;
    throw new Error(`The configured timezone ${timeZone} is invalid.`);
  }
}
