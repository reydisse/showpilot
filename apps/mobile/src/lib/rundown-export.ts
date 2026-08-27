import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import type { RundownItem } from "@/lib/mobile-api";
import { formatTimer } from "@/lib/rundown-state";

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function html(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeFileName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "rundown";
}

function rundownCsv(items: RundownItem[]) {
  const headings = [
    "#",
    "Title",
    "Type",
    "Duration",
    "Assignee",
    "Cue",
    "Notes",
    "Hard stop",
    "Scheduled start",
    "Expected end",
    "Actual start",
    "Actual end",
    "Status",
  ];
  const rows = items.map((item, index) => [
    index + 1,
    item.title,
    item.type,
    formatTimer(item.duration),
    item.assignee,
    item.cue,
    item.notes,
    item.hardStop ? "Yes" : "No",
    item.scheduledStart,
    item.expectedEnd,
    item.actualStart,
    item.actualEnd,
    item.status,
  ]);
  return [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

async function ensureSharing() {
  if (!await Sharing.isAvailableAsync()) {
    throw new Error("File sharing is not available on this device.");
  }
}

export async function shareRundownCsv(input: {
  title: string;
  serviceDate: string;
  items: RundownItem[];
}) {
  await ensureSharing();
  const file = new File(Paths.cache, `${safeFileName(input.title)}-${input.serviceDate}.csv`);
  if (file.exists) file.delete();
  file.create();
  file.write(`\uFEFF${rundownCsv(input.items)}`);
  await Sharing.shareAsync(file.uri, {
    dialogTitle: `Share ${input.title} rundown`,
    mimeType: "text/csv",
    UTI: "public.comma-separated-values-text",
  });
}

export async function shareRundownPdf(input: {
  title: string;
  serviceDate: string;
  startTime?: string | null;
  items: RundownItem[];
}) {
  await ensureSharing();
  const rows = input.items.map((item, index) => `<tr class="${item.type === "header" ? "header" : ""}">
    <td>${index + 1}</td>
    <td><strong>${html(item.title)}</strong>${item.notes ? `<div class="notes">${html(item.notes)}</div>` : ""}</td>
    <td>${html(item.type)}</td>
    <td>${html(formatTimer(item.duration))}</td>
    <td>${html(item.assignee)}</td>
    <td>${html(item.cue)}</td>
  </tr>`).join("");
  const document = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 28px; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; }
    h1 { font-size: 24px; margin: 0 0 4px; }
    .meta { color: #666; font-size: 12px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    th { background: #202020; color: #fff; text-align: left; padding: 7px; }
    td { border-bottom: 1px solid #ddd; padding: 7px; vertical-align: top; }
    tr.header td { background: #fff4d6; color: #7a4d00; font-weight: 700; }
    .notes { color: #666; font-size: 9px; margin-top: 3px; white-space: pre-wrap; }
  </style></head><body>
    <h1>${html(input.title)}</h1>
    <div class="meta">${html(input.serviceDate)}${input.startTime ? ` · ${html(input.startTime)}` : ""} · ${input.items.length} items</div>
    <table><thead><tr><th>#</th><th>Item</th><th>Type</th><th>Duration</th><th>Assignee</th><th>Cue</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`;
  const result = await Print.printToFileAsync({ html: document });
  await Sharing.shareAsync(result.uri, {
    dialogTitle: `Share ${input.title} rundown`,
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
  });
}
