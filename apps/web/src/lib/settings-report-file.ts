import type { ShowReport } from "@/lib/report";
import {
  selectReportExportSections,
  type ReportExportSection,
} from "@/lib/settings-export";
import { spreadsheetSafeCsvCell } from "@showpilot/shared";

export type ReportFileFormat = "json" | "csv" | "xlsx";

/** Produces bytes only. A canceled or timed-out export must never start a download. */
export async function createSettingsReportFile({
  report,
  sections,
  format,
}: {
  report: ShowReport;
  sections: readonly ReportExportSection[];
  format: ReportFileFormat;
}): Promise<Blob> {
  const filteredReport = selectReportExportSections(report, sections);
  let blob: Blob;

  if (format === "json") {
    blob = new Blob([JSON.stringify(filteredReport, null, 2)], {
      type: "application/json",
    });
  } else if (format === "csv") {
    const rows: string[][] = [["section", "field", "value"]];
    const csvValue = (value: unknown) => {
      if (value === undefined || value === null) return "";
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    };

    for (const [section, value] of Object.entries(filteredReport)) {
      if (section === "organization") {
        for (const [field, fieldValue] of Object.entries(value)) {
          rows.push([section, field, csvValue(fieldValue)]);
        }
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          for (const [field, fieldValue] of Object.entries(item)) {
            rows.push([`${section}[${index}]`, field, csvValue(fieldValue)]);
          }
        });
        continue;
      }
      if (value && typeof value === "object") {
        for (const [field, fieldValue] of Object.entries(value)) {
          rows.push([section, field, csvValue(fieldValue)]);
        }
        continue;
      }
      rows.push([section, "value", csvValue(value)]);
    }
    blob = new Blob(
      [rows.map((row) => row.map(spreadsheetSafeCsvCell).join(",")).join("\n")],
      { type: "text/csv" },
    );
  } else {
    const { default: writeExcelFile } =
      await import("write-excel-file/browser");
    const excelValue = (value: unknown): string | number | boolean | Date => {
      if (value === undefined || value === null) return "";
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value instanceof Date
      ) {
        return value;
      }
      return JSON.stringify(value);
    };
    const excelRows = <T extends object>(records: readonly T[]) => {
      const entries = records.map((record) => Object.entries(record));
      const columns = [
        ...new Set(entries.flatMap((record) => record.map(([key]) => key))),
      ];
      return [
        columns.map((column) => ({
          value: column,
          fontWeight: "bold" as const,
        })),
        ...entries.map((record) => {
          const values = new Map(record);
          return columns.map((column) => excelValue(values.get(column)));
        }),
      ];
    };
    const sheets: Array<{
      sheet: string;
      data: ReturnType<typeof excelRows>;
      stickyRowsCount: number;
    }> = [];

    if (sections.includes("summary")) {
      sheets.push({
        sheet: "Summary",
        data: excelRows([report.summary]),
        stickyRowsCount: 1,
      });
    }
    if (sections.includes("rundown")) {
      sheets.push({
        sheet: "Rundown",
        data: excelRows(report.rundown.items),
        stickyRowsCount: 1,
      });
    }
    if (sections.includes("incidents")) {
      sheets.push({
        sheet: "Incidents",
        data: excelRows(report.incidents),
        stickyRowsCount: 1,
      });
    }
    if (sections.includes("checklist")) {
      sheets.push({
        sheet: "Checklist",
        data: excelRows(report.checklist),
        stickyRowsCount: 1,
      });
    }
    if (sections.includes("crew")) {
      sheets.push({
        sheet: "Crew",
        data: excelRows(report.crew),
        stickyRowsCount: 1,
      });
    }
    if (sections.includes("cueSheets")) {
      sheets.push({
        sheet: "Cue Sheets",
        data: excelRows(report.cueSheets),
        stickyRowsCount: 1,
      });
    }
    if (sections.includes("managerNotes")) {
      sheets.push({
        sheet: "Manager Notes",
        data: excelRows(report.managerNotes),
        stickyRowsCount: 1,
      });
    }

    blob = await writeExcelFile(sheets).toBlob();
  }

  return blob;
}
