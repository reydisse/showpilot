import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow, OperationsStat } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getMobileReports, type MobileReports } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

type Report = MobileReports["reports"][number];
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function exportReport(report: Report) {
  if (!await Sharing.isAvailableAsync()) {
    throw new Error("PDF sharing is not available on this device.");
  }
  const title = escapeHtml(report.name || report.serviceDate);
  const rows = [
    ["Service date", report.serviceDate], ["Location", report.location || "—"], ["Status", report.status],
    ["Rundown", `${report.completedItems} of ${report.itemCount} complete`],
    ["Crew", `${report.confirmedAssignments} of ${report.assignmentCount} confirmed`],
    ["Checklist", `${report.completedChecks} of ${report.checklistCount} complete`], ["Incidents", String(report.incidentCount)],
  ];
  const result = await Print.printToFileAsync({ html: `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;padding:40px;color:#171717}h1{font-size:28px}table{width:100%;border-collapse:collapse;margin-top:24px}td{padding:12px;border-bottom:1px solid #ddd}td:first-child{font-weight:700;width:35%}.brand{color:#a15c00;font-weight:800;letter-spacing:.12em}</style></head><body><div class="brand">SHOWPILOT REPORT</div><h1>${title}</h1><table>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</table></body></html>` });
  await Sharing.shareAsync(result.uri, { mimeType: "application/pdf", dialogTitle: `${report.name || report.serviceDate} report` });
}

export default function ReportsScreen() {
  const styles = useStyles();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Report | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["mobile-reports", orgId], queryFn: () => getMobileReports(orgId!), enabled: Boolean(orgId) });
  if (!orgId || query.isPending) return <LoadingView label="Opening reports…" />;
  const reports = query.data?.reports.filter((report) => `${report.name} ${report.serviceDate} ${report.location}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const share = async () => {
    if (!selected || exporting) return;
    setExporting(true); setError("");
    try { await exportReport(selected); } catch (cause) { setError(cause instanceof Error ? cause.message : "Report export failed."); } finally { setExporting(false); }
  };
  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="SHOW HISTORY" title="Reports" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.error ? <OperationsError message={query.error.message} /> : null}{error ? <OperationsError message={error} /> : null}
      <AppField label="Search reports" value={search} onChangeText={setSearch} placeholder="Show, date, or location" />
      {selected ? <OperationsPanel title={selected.name || selected.serviceDate} detail={`${selected.serviceDate} · ${selected.location || "No location"}`}>
        <View style={styles.stats}><OperationsStat label="Rundown" value={`${selected.completedItems}/${selected.itemCount}`} /><OperationsStat label="Crew" value={`${selected.confirmedAssignments}/${selected.assignmentCount}`} /><OperationsStat label="Incidents" value={selected.incidentCount} tone={selected.incidentCount ? "warning" : "good"} /></View>
        <OperationsRow title="Pre-show checklist" status={`${selected.completedChecks}/${selected.checklistCount}`} />
        <AppButton label="Export PDF report" loading={exporting} onPress={() => void share()} />
      </OperationsPanel> : null}
      <OperationsPanel title="Completed and scheduled shows" detail={`${reports.length} reports`}>
        {reports.length ? reports.map((report) => <OperationsRow key={report.id} title={report.name || report.serviceDate} detail={[report.serviceDate, report.location].filter(Boolean).join(" · ")} status={report.status} onPress={() => setSelected(report)} />) : <OperationsEmpty>No reports match this search.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}
const useStyles = createThemedStyles(() => StyleSheet.create({ stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 } }));
