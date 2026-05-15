import { formatTime, formatDuration, itemOverrunMs } from "@/lib/rundown-timing";
import type { RundownItem } from "@/types/rundown";

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
  };
  incidents: Array<{
    id: string;
    category: string;
    severity: string;
    description: string;
    reportedBy: string;
    timestamp: string;
  }>;
}

/** Download a string as a file in the browser. */
function downloadFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export rundown items as a CSV file. */
export function exportRundownCsv(report: ExportReport) {
  const headers = [
    "#",
    "Title",
    "Type",
    "Planned Duration",
    "Scheduled Start",
    "Actual Start",
    "Actual End",
    "Overrun",
    "Status",
    "Assignee",
    "Notes",
    "Cue",
  ];

  const rows = report.rundown.items.map((item, idx) => {
    const overrun = itemOverrunMs(item);
    const overrunStr = overrun === null
      ? ""
      : overrun > 0
        ? `+${Math.round(overrun / 1000)}s`
        : `${Math.round(overrun / 1000)}s`;

    return [
      idx + 1,
      csvEscape(item.title),
      item.type,
      formatDuration(item.duration),
      formatTime(item.scheduledStart),
      formatTime(item.actualStart),
      formatTime(item.actualEnd),
      overrunStr,
      item.status,
      csvEscape(item.assignee),
      csvEscape(item.notes),
      csvEscape(item.cue),
    ];
  });

  const totalPlanned = formatDuration(report.summary.plannedDurationMs);
  const completedCount = report.summary.completedItems;

  const header = [
    `# ${report.organization.name} — Post-Show Report`,
    `# Service Date: ${report.serviceDate}`,
    `# Generated: ${new Date(report.generatedAt).toLocaleString()}`,
    `# Items: ${completedCount}/${report.summary.totalItems} completed  Planned: ${totalPlanned}`,
    "",
    headers.join(","),
  ].join("\n");

  const body = rows.map((r) => r.join(",")).join("\n");

  const incidentSection =
    report.incidents.length > 0
      ? [
          "",
          "# INCIDENTS",
          "Timestamp,Category,Severity,Description,Reported By",
          ...report.incidents.map((inc) =>
            [
              new Date(inc.timestamp).toLocaleTimeString(),
              inc.category,
              inc.severity,
              csvEscape(inc.description),
              csvEscape(inc.reportedBy),
            ].join(",")
          ),
        ].join("\n")
      : "";

  downloadFile(
    `${report.organization.slug}-${report.serviceDate}-report.csv`,
    `${header}\n${body}${incidentSection}`,
    "text/csv",
  );
}

function csvEscape(value: string): string {
  if (!value) return "";
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Export rundown as a formatted PDF using pdfmake. */
export async function exportRundownPdf(report: ExportReport) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfMake = (await import("pdfmake/build/pdfmake")) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfFonts = (await import("pdfmake/build/vfs_fonts")) as any;
  pdfMake.vfs = pdfFonts?.pdfMake?.vfs ?? pdfFonts?.default?.pdfMake?.vfs;

  const completedCount = report.summary.completedItems;
  const totalPlanned = formatDuration(report.summary.plannedDurationMs);

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
    ...report.rundown.items.map((item, idx) => {
      const overrun = itemOverrunMs(item);
      const overrunStr =
        overrun === null
          ? ""
          : overrun > 0
            ? `+${Math.round(overrun / 1000)}s`
            : `${Math.round(overrun / 1000)}s`;
      const isLate = overrun !== null && overrun > 30000;
      const rowStyle = item.status === "complete" ? "rowComplete" : "rowNormal";

      return [
        { text: String(idx + 1), style: rowStyle },
        { text: item.title || "Untitled", style: rowStyle },
        { text: item.type, style: rowStyle },
        { text: formatDuration(item.duration), style: [rowStyle, "mono"] },
        { text: formatTime(item.scheduledStart), style: [rowStyle, "mono"] },
        { text: formatTime(item.actualStart), style: [rowStyle, "mono"] },
        { text: formatTime(item.actualEnd), style: [rowStyle, "mono"] },
        { text: overrunStr, style: [rowStyle, "mono", isLate ? "late" : ""] },
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
    ],
    styles: {
      orgName: { fontSize: 16, bold: true, color: "#f0f0f0" },
      serviceDate: { fontSize: 10, color: "#999" },
      reportTitle: { fontSize: 11, color: "#aaa", marginBottom: 4 },
      meta: { fontSize: 9, color: "#888", marginBottom: 12 },
      sectionHeader: { fontSize: 12, bold: true, color: "#f0f0f0", margin: [0, 12, 0, 4] },
      tableHeader: { bold: true, fontSize: 8, color: "#aaa", fillColor: "#1a1a1a" },
      rowNormal: { fontSize: 8, color: "#e0e0e0" },
      rowComplete: { fontSize: 8, color: "#666" },
      mono: { font: "Courier" },
      late: { color: "#ff6b6b" },
    },
    defaultStyle: { font: "Helvetica", fontSize: 9 },
    pageSize: "A4",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfMake.createPdf(docDefinition as any).download(
    `${report.organization.slug}-${report.serviceDate}-report.pdf`,
  );
}
