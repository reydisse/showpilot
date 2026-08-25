export interface ServicePickerOption {
  name?: string | null;
  serviceDate: string;
  scheduledStartTime?: string | Date | null;
}

interface ServicePickerLabelOptions {
  timeZone?: string;
  today?: string;
}

function formatServiceDate(serviceDate: string): string {
  const date = new Date(`${serviceDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return serviceDate;

  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatServiceTime(value: string | Date, timeZone?: string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

/** A single, unambiguous label for selecting a dated service occurrence. */
export function formatServicePickerLabel(
  service: ServicePickerOption,
  options: ServicePickerLabelOptions = {},
): string {
  const date = formatServiceDate(service.serviceDate);
  const name = service.name?.trim();
  const parts = [name ? `${name} — ${date}` : date];
  const time = service.scheduledStartTime
    ? formatServiceTime(service.scheduledStartTime, options.timeZone)
    : null;

  if (time) parts.push(time);
  if (options.today === service.serviceDate) parts.push("today");
  return parts.join(" · ");
}
