import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow, OperationsStat } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getMobileReports, saveMobileShowReportNote, type MobileReports } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily } from "@/theme/tokens";

type Report = MobileReports["reports"][number];
type ReportNote = MobileReports["notes"][number];
type ReportLane = MobileReports["viewer"]["writableNoteLanes"][number];
type NoteDraft = Pick<ReportNote, "summary" | "wins" | "issues" | "followUps">;
const emptyDraft: NoteDraft = { summary: "", wins: "", issues: "", followUps: "" };
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function exportReport(report: Report, notes: ReportNote[]) {
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
  const noteHtml = notes.length ? `<h2>Post-show notes</h2>${notes.map((note) => `<section><h3>${escapeHtml(note.role === "pm" ? "Production Manager" : "Technical Manager")} · ${escapeHtml(note.authorName)}</h3>${[["Summary", note.summary], ["What worked", note.wins], ["Issues / changes", note.issues], ["Follow-up", note.followUps]].filter(([, value]) => value).map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`).join("")}</section>`).join("")}` : "";
  const result = await Print.printToFileAsync({ html: `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,sans-serif;padding:40px;color:#171717}h1{font-size:28px}h2{margin-top:32px}h3{font-size:16px;margin-bottom:8px}section{border-top:1px solid #ddd;padding:10px 0}table{width:100%;border-collapse:collapse;margin-top:24px}td{padding:12px;border-bottom:1px solid #ddd}td:first-child{font-weight:700;width:35%}.brand{color:#a15c00;font-weight:800;letter-spacing:.12em}</style></head><body><div class="brand">SHOWPILOT REPORT</div><h1>${title}</h1><table>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join("")}</table>${noteHtml}</body></html>` });
  await Sharing.shareAsync(result.uri, { mimeType: "application/pdf", dialogTitle: `${report.name || report.serviceDate} report` });
}

export default function ReportsScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Report | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [lane, setLane] = useState<ReportLane>("pm");
  const [draft, setDraft] = useState<NoteDraft>(emptyDraft);
  const query = useQuery({ queryKey: ["mobile-reports", orgId], queryFn: () => getMobileReports(orgId!), enabled: Boolean(orgId) });
  const noteMutation = useMutation({
    mutationFn: saveMobileShowReportNote,
    onSuccess: async () => {
      setError("");
      setSaved("Notes saved. They are now included in report exports.");
      await queryClient.invalidateQueries({ queryKey: ["mobile-reports", orgId] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "The notes could not be saved."),
  });
  if (!orgId || query.isPending) return <LoadingView label="Opening reports…" />;
  const data = query.data;
  const reports = query.data?.reports.filter((report) => `${report.name} ${report.serviceDate} ${report.location}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const selectedNotes = selected ? data?.notes.filter((note) => note.showId === selected.id) ?? [] : [];
  const chooseReport = (report: Report) => {
    const ownNote = data?.notes.find((note) => note.showId === report.id && note.userId === data.viewer.userId);
    setSelected(report);
    setLane(ownNote?.role ?? data?.viewer.writableNoteLanes[0] ?? "pm");
    setDraft(ownNote ? { summary: ownNote.summary, wins: ownNote.wins, issues: ownNote.issues, followUps: ownNote.followUps } : emptyDraft);
    setSaved("");
    setError("");
  };
  const share = async () => {
    if (!selected || exporting) return;
    setExporting(true); setError("");
    try { await exportReport(selected, selectedNotes); } catch (cause) { setError(cause instanceof Error ? cause.message : "Report export failed."); } finally { setExporting(false); }
  };
  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="SHOW HISTORY" title="Reports & notes" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.error ? <OperationsError message={query.error.message} /> : null}{error ? <OperationsError message={error} /> : null}
      <OperationsPanel title="Post-show notes live here" detail="Everyone can read the show handoff. PMs and TMs can add or update their notes at any time." />
      <AppField label="Search reports" value={search} onChangeText={setSearch} placeholder="Show, date, or location" />
      {selected ? <OperationsPanel title={selected.name || selected.serviceDate} detail={`${selected.serviceDate} · ${selected.location || "No location"}`}>
        <View style={styles.stats}><OperationsStat label="Rundown" value={`${selected.completedItems}/${selected.itemCount}`} /><OperationsStat label="Crew" value={`${selected.confirmedAssignments}/${selected.assignmentCount}`} /><OperationsStat label="Incidents" value={selected.incidentCount} tone={selected.incidentCount ? "warning" : "good"} /></View>
        <OperationsRow title="Pre-show checklist" status={`${selected.completedChecks}/${selected.checklistCount}`} />
        <View style={styles.notesBlock}>
          <Text style={styles.notesTitle}>Team handoff</Text>
          {selectedNotes.length ? selectedNotes.map((note) => (
            <View key={note.id} style={styles.noteCard}>
              <Text style={styles.noteAuthor}>{note.role === "pm" ? "Production Manager" : "Technical Manager"} · {note.authorName}</Text>
              {note.summary ? <Text style={styles.noteBody}>{note.summary}</Text> : null}
              {note.wins ? <Text style={styles.noteMeta}>WHAT WORKED{`\n`}<Text style={styles.noteBody}>{note.wins}</Text></Text> : null}
              {note.issues ? <Text style={styles.noteMeta}>ISSUES / CHANGES{`\n`}<Text style={styles.noteBody}>{note.issues}</Text></Text> : null}
              {note.followUps ? <Text style={styles.noteMeta}>FOLLOW-UP{`\n`}<Text style={styles.noteBody}>{note.followUps}</Text></Text> : null}
            </View>
          )) : <OperationsEmpty>No PM or TM notes have been added yet.</OperationsEmpty>}
        </View>
        {data?.viewer.writableNoteLanes.length ? (
          <View style={styles.editor}>
            <Text style={styles.notesTitle}>Add my notes</Text>
            {data.viewer.writableNoteLanes.length > 1 ? <View style={styles.laneRow}>{data.viewer.writableNoteLanes.map((value) => <View key={value} style={styles.laneButton}><AppButton label={value === "pm" ? "PM note" : "TM note"} variant={lane === value ? "primary" : "secondary"} onPress={() => setLane(value)} /></View>)}</View> : null}
            <AppField label="Overall summary" value={draft.summary} onChangeText={(summary) => setDraft({ ...draft, summary })} multiline maxLength={4000} style={styles.noteField} autoCapitalize="sentences" />
            <AppField label="What worked" value={draft.wins} onChangeText={(wins) => setDraft({ ...draft, wins })} multiline maxLength={4000} style={styles.noteField} autoCapitalize="sentences" />
            <AppField label="Issues or changes" value={draft.issues} onChangeText={(issues) => setDraft({ ...draft, issues })} multiline maxLength={4000} style={styles.noteField} autoCapitalize="sentences" />
            <AppField label="Follow-up" value={draft.followUps} onChangeText={(followUps) => setDraft({ ...draft, followUps })} multiline maxLength={4000} style={styles.noteField} autoCapitalize="sentences" />
            {saved ? <Text accessibilityLiveRegion="polite" style={styles.saved}>{saved}</Text> : null}
            <AppButton label="Save my notes" loading={noteMutation.isPending} onPress={() => { setSaved(""); noteMutation.mutate({ orgId, showId: selected.id, role: lane, ...draft }); }} />
          </View>
        ) : null}
        <AppButton label="Export PDF report" loading={exporting} onPress={() => void share()} />
      </OperationsPanel> : null}
      <OperationsPanel title="Completed and scheduled shows" detail={`${reports.length} reports`}>
        {reports.length ? reports.map((report) => <OperationsRow key={report.id} title={report.name || report.serviceDate} detail={[report.serviceDate, report.location].filter(Boolean).join(" · ")} status={report.status} onPress={() => chooseReport(report)} />) : <OperationsEmpty>No reports match this search.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  notesBlock: { gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingTop: 12 },
  notesTitle: { color: colors.text, fontFamily, fontSize: 15, lineHeight: 21, fontWeight: "800" },
  noteCard: { gap: 8, borderRadius: 14, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 13 },
  noteAuthor: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 19, fontWeight: "800" },
  noteBody: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 20, fontWeight: "400", textTransform: "none" },
  noteMeta: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 18, fontWeight: "800" },
  editor: { gap: 11, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingTop: 12 },
  laneRow: { flexDirection: "row", gap: 8 },
  laneButton: { flex: 1 },
  noteField: { minHeight: 92, paddingTop: 13, textAlignVertical: "top" },
  saved: { color: colors.green, fontFamily, fontSize: 12, lineHeight: 18, fontWeight: "700" },
}));
