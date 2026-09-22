import type { ShowReport } from "@/lib/report";

export const REPORT_EXPORT_SECTIONS = [
  ["summary", "Summary"],
  ["rundown", "Rundown"],
  ["incidents", "Incidents"],
  ["checklist", "Checklist"],
  ["crew", "Crew"],
  ["cueSheets", "Cue Sheets"],
  ["managerNotes", "Manager Notes"],
] as const;

export type ReportExportSection = typeof REPORT_EXPORT_SECTIONS[number][0];

export function selectReportExportSections(
  report: ShowReport,
  sections: readonly ReportExportSection[],
) {
  return {
    generatedAt: report.generatedAt,
    serviceDate: report.serviceDate,
    organization: report.organization,
    ...(sections.includes("summary") ? { summary: report.summary } : {}),
    ...(sections.includes("rundown") ? { rundown: report.rundown } : {}),
    ...(sections.includes("incidents") ? { incidents: report.incidents } : {}),
    ...(sections.includes("checklist") ? { checklist: report.checklist } : {}),
    ...(sections.includes("crew") ? { crew: report.crew } : {}),
    ...(sections.includes("cueSheets") ? { cueSheets: report.cueSheets } : {}),
    ...(sections.includes("managerNotes") ? { managerNotes: report.managerNotes } : {}),
  };
}
