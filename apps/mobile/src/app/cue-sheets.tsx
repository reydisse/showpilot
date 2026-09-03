import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getMobileCueSheet, writeMobileCueSheet, type MobileCueSheet } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily } from "@/theme/tokens";

type SelectedCell = { row: MobileCueSheet["rows"][number]; column: MobileCueSheet["columns"][number]; text: string };

export default function CueSheetsScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [showId, setShowId] = useState<string>();
  const [columnLabel, setColumnLabel] = useState("");
  const [selected, setSelected] = useState<SelectedCell | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["mobile-cue-sheet", orgId, showId], queryFn: () => getMobileCueSheet(orgId!, showId), enabled: Boolean(orgId) });
  const mutation = useMutation({
    mutationFn: writeMobileCueSheet,
    onSuccess: async () => {
      setError("");
      setColumnLabel("");
      setSelected(null);
      await queryClient.invalidateQueries({ queryKey: ["mobile-cue-sheet", orgId] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Cue sheet update failed."),
  });
  useEffect(() => {
    if (!showId && query.data?.show?.id) setShowId(query.data.show.id);
  }, [query.data?.show?.id, showId]);

  if (!orgId || query.isPending) return <LoadingView label="Opening cue sheets…" />;
  const data = query.data;
  const write = (input: Omit<Parameters<typeof writeMobileCueSheet>[0], "orgId">) => mutation.mutate({ orgId, ...input });

  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="RUN OF SHOW" title="Cue Sheets" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.error ? <OperationsError message={query.error.message} /> : null}
      {error ? <OperationsError message={error} /> : null}
      <OperationsPanel title={data?.show?.name || data?.show?.serviceDate || "No scheduled show"} detail={data?.show ? `${data.show.serviceDate} · ${data.rows.length} cues` : "Create a show and rundown before adding cues."}>
        <View style={styles.showChooser}>
          {data?.shows.map((show) => <View key={show.id} style={styles.showButton}><AppButton label={show.name || show.serviceDate} variant={show.id === data.show?.id ? "primary" : "secondary"} onPress={() => setShowId(show.id)} /></View>)}
        </View>
      </OperationsPanel>
      {data?.canEdit ? (
        <OperationsPanel title="Departments" detail="Add and order the columns teams read during the show.">
          <AppField label="New department" value={columnLabel} onChangeText={setColumnLabel} placeholder="Lighting" />
          <AppButton label="Add department" disabled={!columnLabel.trim() || mutation.isPending} onPress={() => write({ action: "add-column", label: columnLabel, color: "amber" })} />
          {data.columns.map((column, index) => (
            <View key={column.id} style={styles.columnRow}>
              <View style={styles.columnCopy}><Text style={styles.columnTitle}>{column.label}</Text><Text style={styles.columnMeta}>{column.color}</Text></View>
              <View style={styles.smallButton}><AppButton label="↑" variant="secondary" disabled={index === 0} accessibilityLabel={`Move ${column.label} earlier`} onPress={() => write({ action: "move-column", columnId: column.id, sortOrder: data.columns[index - 1]?.sortOrder ?? column.sortOrder })} /></View>
              <View style={styles.smallButton}><AppButton label="↓" variant="secondary" disabled={index === data.columns.length - 1} accessibilityLabel={`Move ${column.label} later`} onPress={() => write({ action: "move-column", columnId: column.id, sortOrder: data.columns[index + 1]?.sortOrder ?? column.sortOrder })} /></View>
              <View style={styles.removeButton}><AppButton label="Remove" variant="danger" accessibilityLabel={`Remove ${column.label}`} onPress={() => Alert.alert("Remove department?", `Remove “${column.label}” and every cue note in that column?`, [{ text: "Cancel", style: "cancel" }, { text: "Remove", style: "destructive", onPress: () => write({ action: "remove-column", columnId: column.id }) }])} /></View>
            </View>
          ))}
        </OperationsPanel>
      ) : null}
      {selected && data?.show ? (
        <OperationsPanel title={`${selected.column.label} · ${selected.row.title}`} detail="Changes are attributed to your signed-in identity.">
          <AppField label="Cue instruction" value={selected.text} onChangeText={(text) => setSelected({ ...selected, text })} multiline style={styles.noteField} />
          <View style={styles.buttonRow}>
            <View style={styles.flex}><AppButton label="Cancel" variant="secondary" onPress={() => setSelected(null)} /></View>
            <View style={styles.flex}><AppButton label="Save cue" loading={mutation.isPending} onPress={() => write({ action: "upsert-note", showId: data.show!.id, itemId: selected.row.id, columnId: selected.column.id, text: selected.text })} /></View>
          </View>
        </OperationsPanel>
      ) : null}
      <OperationsPanel title="Live cue grid" detail="Tap any department instruction to edit it.">
        {data?.rows.length ? data.rows.map((row) => (
          <View key={row.id} style={styles.cueRow}>
            <OperationsRow title={row.title} detail={[row.cue, row.assignee].filter(Boolean).join(" · ")} status={row.status} />
            {data.columns.map((column) => {
              const note = row.notes.find((item) => item.columnId === column.id);
              return <OperationsRow key={column.id} title={column.label} detail={note?.text || "No instruction"} onPress={data.canAddNotes ? () => setSelected({ row, column, text: note?.text ?? "" }) : undefined} />;
            })}
          </View>
        )) : <OperationsEmpty>No rundown cues are available for this show.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  showChooser: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  showButton: { minWidth: 130, flexGrow: 1 },
  columnRow: { flexDirection: "row", alignItems: "center", gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingTop: 10 },
  columnCopy: { flex: 1, minWidth: 0 },
  columnTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
  columnMeta: { color: colors.textMuted, fontFamily, fontSize: 11, textTransform: "uppercase" },
  smallButton: { width: 54 },
  removeButton: { width: 96 },
  noteField: { minHeight: 94, paddingTop: 13, textAlignVertical: "top" },
  buttonRow: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  cueRow: { borderRadius: 14, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, paddingHorizontal: 12 },
}));
