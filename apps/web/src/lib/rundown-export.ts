import { formatTime, formatDuration, itemOverrunMs } from "@/lib/rundown-timing";
import { rundownItemNumbers, type RundownItem } from "@/types/rundown";

export interface ExportReport {
  generatedAt: string;
  serviceDate: string;
  organization: { id: string; name: string; slug: string };
  summary: {
    totalItems: number;
    completedItems: number;
    plannedDurationMs: number;
    elapsedMs: number;
  };
  rundown: {
    items: RundownItem[];
    stageMessage: string;
    name?: string;
    scheduledStartTime?: string | null;
  };
  incidents: Array<{
    id: string;
    category: string;
    severity: string;
    description: string;
    reportedBy: string;
    timestamp: string;
  }>;
  checklist?: Array<{ label: string; category: string; checked: boolean; checkedBy: string | null; checkedAt?: string | null }>;
  crew?: Array<{ role: string; name: string; status: string; notes: string }>;
  cueSheets?: Array<{ cueNumber: number; rundownItem: string; cameraAssignments: string; notes: string }>;
}

/** Download a string as a file in the browser. */
function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Give the browser a tick to hand the blob to its download manager before
  // releasing the object URL (important in Safari and embedded webviews).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export rundown items as a CSV file. */
export function exportRundownCsv(report: ExportReport) {
  const csv = buildRundownCsv(report);

  downloadFile(
    `${report.organization.slug}-${report.serviceDate}-report.csv`,
    `\uFEFF${csv}\r\n`,
    "text/csv;charset=utf-8",
  );
}

/** Build the rectangular report CSV independently of browser download APIs. */
export function buildRundownCsv(report: ExportReport): string {
  const headers = [
    "Record Type",
    "Service Date",
    "Show",
    "Generated At",
    "Item #",
    "Title",
    "Item Type",
    "Category",
    "Role",
    "Person",
    "Planned Duration",
    "Scheduled Start",
    "Actual Start",
    "Actual End",
    "Timestamp",
    "Overrun",
    "Status",
    "Severity",
    "Description",
    "Notes",
    "Cue",
    "Checked At",
  ];

  const itemNumbers = rundownItemNumbers(report.rundown.items);
  const base = {
    serviceDate: report.serviceDate,
    show: report.rundown.name || report.organization.name,
    generatedAt: new Date(report.generatedAt).toLocaleString(),
  };
  const rows: unknown[][] = report.rundown.items.map((item) => {
    const overrun = itemOverrunMs(item);
    const overrunStr = overrun === null
      ? ""
      : overrun > 0
        ? `+${Math.round(overrun / 1000)}s`
        : `${Math.round(overrun / 1000)}s`;

    return [
      "Rundown item",
      base.serviceDate,
      base.show,
      base.generatedAt,
      itemNumbers.get(item.id) ?? "",
      item.title,
      item.type,
      "",
      "",
      item.assignee,
      formatDuration(item.duration),
      formatTime(item.scheduledStart),
      formatTime(item.actualStart),
      formatTime(item.actualEnd),
      "",
      overrunStr,
      item.status,
      "",
      "",
      item.notes,
      item.cue,
      "",
    ];
  });

  rows.push(
    ...report.incidents.map((incident) => [
      "Incident", base.serviceDate, base.show, base.generatedAt, "", "", "",
      incident.category, "", incident.reportedBy, "", "", "", "",
      new Date(incident.timestamp).toLocaleString(), "", "", incident.severity,
      incident.description, "", "", "",
    ]),
    ...(report.checklist ?? []).map((item) => [
      "Checklist", base.serviceDate, base.show, base.generatedAt, "", item.label,
      "", item.category, "", item.checkedBy ?? "", "", "", "", "",
      "", "", item.checked ? "Complete" : "Incomplete", "", "", "", "",
      item.checkedAt ? new Date(item.checkedAt).toLocaleString() : "",
    ]),
    ...(report.crew ?? []).map((member) => [
      "Crew", base.serviceDate, base.show, base.generatedAt, "", "", "", "",
      member.role, member.name, "", "", "", "", "", "", member.status,
      "", "", member.notes, "", "",
    ]),
    ...(report.cueSheets ?? []).map((cue) => [
      "Cue sheet", base.serviceDate, base.show, base.generatedAt, cue.cueNumber,
      cue.rundownItem, "", "", "", "", "", "", "", "", "", "", "", "",
      "", cue.notes, cue.cameraAssignments, "",
    ]),
  );

  return [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\r\n");
}

function csvEscape(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  if (!text) return "";
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Export rundown as a formatted PDF using pdfmake. */
export async function exportRundownPdf(report: ExportReport) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfMakeModule = (await import("pdfmake/build/pdfmake.js")) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfFonts = (await import("pdfmake/build/vfs_fonts.js")) as any;
  const pdfMake = pdfMakeModule.default ?? pdfMakeModule;
  const fontContainer = pdfFonts.default ?? pdfFonts["module.exports"] ?? pdfFonts;
  // pdfmake 0.3 replaced the old `pdfMake.vfs = ...` assignment with an
  // explicit virtual file-system registration method.
  if (typeof pdfMake.addFontContainer === "function" && fontContainer?.vfs) {
    pdfMake.addFontContainer(fontContainer);
  } else if (typeof pdfMake.addVirtualFileSystem === "function") {
    pdfMake.addVirtualFileSystem(fontContainer?.vfs ?? fontContainer);
  } else {
    pdfMake.vfs = fontContainer?.vfs ?? fontContainer;
  }

  const completedCount = report.summary.completedItems;
  const totalPlanned = formatDuration(report.summary.plannedDurationMs);
  const itemNumbers = rundownItemNumbers(report.rundown.items);

  const tableBody: unknown[][] = [
    [
      { text: "#", style: "tableHeader" },
      { text: "Title", style: "tableHeader" },
      { text: "Type", style: "tableHeader" },
      { text: "Planned", style: "tableHeader" },
      { text: "Sched", style: "tableHeader" },
      { text: "Start", style: "tableHeader" },
      { text: "End", style: "tableHeader" },
      { text: "Overrun", style: "tableHeader" },
      { text: "Status", style: "tableHeader" },
    ],
    ...report.rundown.items.map((item) => {
      const overrun = itemOverrunMs(item);
      const overrunStr =
        overrun === null
          ? ""
          : overrun > 0
            ? `+${Math.round(overrun / 1000)}s`
            : `${Math.round(overrun / 1000)}s`;
      const isLate = overrun !== null && overrun > 30000;
      const rowStyle = item.status === "complete" ? "rowComplete" : "rowNormal";
      const cellStyle = isLate ? [rowStyle, "mono", "late"] : [rowStyle, "mono"];

      return [
        { text: itemNumbers.get(item.id) ?? "", style: rowStyle },
        { text: item.title || "Untitled", style: rowStyle },
        { text: item.type, style: rowStyle },
        { text: formatDuration(item.duration), style: [rowStyle, "mono"] },
        { text: formatTime(item.scheduledStart), style: [rowStyle, "mono"] },
        { text: formatTime(item.actualStart), style: [rowStyle, "mono"] },
        { text: formatTime(item.actualEnd), style: [rowStyle, "mono"] },
        { text: overrunStr, style: cellStyle },
        { text: item.status, style: rowStyle },
      ];
    }),
  ];

  const incidentsSection =
    report.incidents.length > 0
      ? [
          { text: "Incidents", style: "sectionHeader" },
          {
            table: {
              headerRows: 1,
              widths: ["auto", "auto", "auto", "*", "auto"],
              body: [
                [
                  { text: "Time", style: "tableHeader" },
                  { text: "Category", style: "tableHeader" },
                  { text: "Severity", style: "tableHeader" },
                  { text: "Description", style: "tableHeader" },
                  { text: "Reported By", style: "tableHeader" },
                ],
                ...report.incidents.map((inc) => [
                  new Date(inc.timestamp).toLocaleTimeString(),
                  inc.category,
                  inc.severity,
                  inc.description,
                  inc.reportedBy,
                ]),
              ],
            },
          },
        ]
      : [];
  const checklistSection = report.checklist?.length ? [{ text: "Checklist", style: "sectionHeader" }, { table: { headerRows: 1, widths: ["auto", "*", "auto", "auto"], body: [[{ text: "Category", style: "tableHeader" }, { text: "Item", style: "tableHeader" }, { text: "Status", style: "tableHeader" }, { text: "Checked By", style: "tableHeader" }], ...report.checklist.map((item) => [item.category, item.label, item.checked ? "Complete" : "Incomplete", item.checkedBy ?? "—"])] }, layout: "lightHorizontalLines" }] : [];
  const crewSection = report.crew?.length ? [{ text: "Crew", style: "sectionHeader" }, { table: { headerRows: 1, widths: ["*", "*", "auto"], body: [[{ text: "Position", style: "tableHeader" }, { text: "Crew Member", style: "tableHeader" }, { text: "Status", style: "tableHeader" }], ...report.crew.map((item) => [item.role, item.name, item.status])] }, layout: "lightHorizontalLines" }] : [];

  const docDefinition = {
    pageMargins: [36, 48, 36, 36] as [number, number, number, number],
    content: [
      {
        columns: [
          { text: report.organization.name, style: "orgName" },
          { text: `Service: ${report.serviceDate}`, style: "serviceDate", alignment: "right" },
        ],
      },
      { text: "Post-Show Report", style: "reportTitle" },
      { text: report.rundown.name || "Service rundown", style: "serviceName" },
      {
        columns: [
          { text: `Generated: ${new Date(report.generatedAt).toLocaleString()}`, style: "meta" },
          { text: `${completedCount}/${report.summary.totalItems} items · ${totalPlanned} planned`, style: "meta", alignment: "right" },
        ],
      },
      { text: "", margin: [0, 8, 0, 0] },
      { text: "Rundown", style: "sectionHeader" },
      {
        table: {
          headerRows: 1,
          widths: ["auto", "*", "auto", "auto", "auto", "auto", "auto", "auto", "auto"],
          body: tableBody,
        },
        layout: "lightHorizontalLines",
      },
      ...incidentsSection,
      ...checklistSection,
      ...crewSection,
    ],
    styles: {
      orgName: { fontSize: 16, bold: true, color: "#111827" },
      serviceDate: { fontSize: 10, color: "#4b5563" },
      reportTitle: { fontSize: 9, bold: true, color: "#b45309", marginBottom: 2 },
      serviceName: { fontSize: 13, bold: true, color: "#111827", marginBottom: 6 },
      meta: { fontSize: 9, color: "#4b5563", marginBottom: 12 },
      sectionHeader: { fontSize: 12, bold: true, color: "#111827", margin: [0, 12, 0, 4] },
      tableHeader: { bold: true, fontSize: 8, color: "#ffffff", fillColor: "#1f2937" },
      rowNormal: { fontSize: 8, color: "#111827" },
      rowComplete: { fontSize: 8, color: "#6b7280" },
      mono: { font: "Roboto", fontSize: 8 },
      late: { color: "#ff6b6b" },
    },
    defaultStyle: { font: "Roboto", fontSize: 9 },
    pageSize: "A4",
    pageOrientation: "landscape",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pdfMake.createPdf(docDefinition as any).download(
    `${report.organization.slug}-${report.serviceDate}-report.pdf`,
  );
}
