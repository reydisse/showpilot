import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ArrowDown from "lucide-react-native/icons/arrow-down";
import ArrowUp from "lucide-react-native/icons/arrow-up";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import Settings2 from "lucide-react-native/icons/settings-2";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getMobileCueSheet, writeMobileCueSheet, type MobileCueSheet } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type CueRow = MobileCueSheet["rows"][number];
type CueColumn = MobileCueSheet["columns"][number];
type EditorSelection = { rowId: string; columnId: string; draft: string };
type WriteInput = Omit<Parameters<typeof writeMobileCueSheet>[0], "orgId">;

function formatDuration(durationMs: number) {
  const safeSeconds = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs / 1_000)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatStartTime(value?: string | null) {
  if (!value) return "Time not set";
  const match = /(?:T|^)(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = match[2];
  if (!Number.isFinite(hour)) return value;
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatServiceDate(value: string) {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function cueTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized.includes("complete") || normalized.includes("done")) return "complete" as const;
  if (normalized.includes("live") || normalized.includes("active") || normalized.includes("progress")) return "live" as const;
  return "ready" as const;
}

function noteFor(row: CueRow, columnId: string) {
  return row.notes.find((note) => note.columnId === columnId);
}

function StatusDot({ status }: { status: string }) {
  const styles = useStyles();
  const tone = cueTone(status);
  return <View accessibilityLabel={status || "Ready"} style={[styles.statusDot, tone === "complete" ? styles.statusComplete : tone === "live" ? styles.statusLive : styles.statusReady]} />;
}

function ShowPicker({ data, onClose, onSelect }: { data: MobileCueSheet; onClose: () => void; onSelect: (showId: string) => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View accessibilityViewIsModal style={styles.modalPage}>
        <View style={styles.modalHeader}>
          <View style={styles.modalHeading}>
            <Text style={styles.modalTitle}>Choose a show</Text>
            <Text style={styles.modalSubtitle}>The cue sheet follows the selected rundown.</Text>
          </View>
          <Pressable accessibilityLabel="Close show picker" accessibilityRole="button" hitSlop={8} onPress={onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <X color={colors.text} size={21} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalList}>
          {data.shows.map((show) => {
            const active = show.id === data.show?.id;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                key={show.id}
                onPress={() => onSelect(show.id)}
                style={({ pressed }) => [styles.showOption, active && styles.showOptionActive, pressed && styles.pressed]}
              >
                <View style={styles.showOptionCopy}>
                  <Text numberOfLines={1} style={styles.showOptionTitle}>{show.name || "Untitled show"}</Text>
                  <Text style={styles.showOptionMeta}>{formatServiceDate(show.serviceDate)} · {formatStartTime(show.scheduledStartTime)}</Text>
                </View>
                {active ? <View style={styles.activeMark} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

function DepartmentManager({ columns, columnLabel, pending, onChangeLabel, onClose, onAdd, onMove, onRemove }: {
  columns: CueColumn[];
  columnLabel: string;
  pending: boolean;
  onChangeLabel: (value: string) => void;
  onClose: () => void;
  onAdd: () => void;
  onMove: (column: CueColumn, sortOrder: number) => void;
  onRemove: (column: CueColumn) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View accessibilityViewIsModal style={styles.modalPage}>
        <View style={styles.modalHeader}>
          <View style={styles.modalHeading}>
            <Text style={styles.modalTitle}>Departments</Text>
            <Text style={styles.modalSubtitle}>Choose the lanes your teams write against.</Text>
          </View>
          <Pressable accessibilityLabel="Close department settings" accessibilityRole="button" hitSlop={8} onPress={onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
            <X color={colors.text} size={21} />
          </Pressable>
        </View>
        <View style={styles.addDepartment}>
          <View style={styles.addDepartmentField}>
            <AppField autoCapitalize="words" label="New department" onChangeText={onChangeLabel} placeholder="Lighting" value={columnLabel} />
          </View>
          <Pressable accessibilityLabel="Add department" accessibilityRole="button" disabled={!columnLabel.trim() || pending} onPress={onAdd} style={({ pressed }) => [styles.addButton, (!columnLabel.trim() || pending) && styles.disabled, pressed && styles.pressed]}>
            <Plus color={colors.black} size={22} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.departmentList}>
          {columns.map((column, index) => (
            <View key={column.id} style={styles.departmentRow}>
              <View style={styles.departmentCopy}>
                <Text style={styles.departmentTitle}>{column.label}</Text>
                <Text style={styles.departmentMeta}>Lane {index + 1}</Text>
              </View>
              <Pressable accessibilityLabel={`Move ${column.label} earlier`} accessibilityRole="button" disabled={index === 0 || pending} onPress={() => onMove(column, columns[index - 1]?.sortOrder ?? column.sortOrder)} style={({ pressed }) => [styles.iconButton, (index === 0 || pending) && styles.disabled, pressed && styles.pressed]}>
                <ArrowUp color={colors.text} size={19} />
              </Pressable>
              <Pressable accessibilityLabel={`Move ${column.label} later`} accessibilityRole="button" disabled={index === columns.length - 1 || pending} onPress={() => onMove(column, columns[index + 1]?.sortOrder ?? column.sortOrder)} style={({ pressed }) => [styles.iconButton, (index === columns.length - 1 || pending) && styles.disabled, pressed && styles.pressed]}>
                <ArrowDown color={colors.text} size={19} />
              </Pressable>
              <Pressable accessibilityLabel={`Remove ${column.label}`} accessibilityRole="button" disabled={pending} onPress={() => onRemove(column)} style={({ pressed }) => [styles.iconButton, styles.dangerIconButton, pending && styles.disabled, pressed && styles.pressed]}>
                <Trash2 color={colors.red} size={18} />
              </Pressable>
            </View>
          ))}
          {!columns.length ? <OperationsEmpty>Add a department to start writing cue notes.</OperationsEmpty> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function NoteEditor({ column, draft, pending, row, onCancel, onChange, onSave, compact = false }: {
  column: CueColumn;
  draft: string;
  pending: boolean;
  row: CueRow;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSave: () => void;
  compact?: boolean;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={[styles.editor, compact && styles.editorCompact]}>
      <View style={styles.editorHeading}>
        <View style={styles.editorCopy}>
          <Text style={styles.editorTitle}>Edit department note</Text>
          <Text numberOfLines={2} style={styles.editorMeta}>{column.label} · {row.title}</Text>
        </View>
        {compact ? (
          <Pressable accessibilityLabel="Close note editor" accessibilityRole="button" hitSlop={8} onPress={onCancel} style={({ pressed }) => [styles.compactClose, pressed && styles.pressed]}>
            <X color={colors.textMuted} size={20} />
          </Pressable>
        ) : null}
      </View>
      <AppField autoCapitalize="sentences" autoFocus={compact} label="Cue instruction" multiline onChangeText={onChange} placeholder="No instruction" style={[styles.noteField, !compact && styles.noteFieldTall]} value={draft} />
      <View style={styles.editorActions}>
        <View style={styles.actionButton}><AppButton label="Cancel" onPress={onCancel} variant="secondary" /></View>
        <View style={styles.actionButton}><AppButton label="Save note" loading={pending} onPress={onSave} /></View>
      </View>
    </View>
  );
}

function PhoneCueRow({ columns, departmentId, index, row, onEdit }: {
  columns: CueColumn[];
  departmentId: string;
  index: number;
  row: CueRow;
  onEdit: (row: CueRow, column: CueColumn) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const visibleColumns = departmentId === "all" ? columns : columns.filter((column) => column.id === departmentId);
  return (
    <View style={styles.phoneCueRow}>
      <View style={styles.cueIdentity}>
        <Text style={styles.cueNumber}>{index + 1}</Text>
        <StatusDot status={row.status} />
        <View style={styles.cueCopy}>
          <Text numberOfLines={1} style={styles.cueTitle}>{row.title}</Text>
          <Text numberOfLines={1} style={styles.cueMeta}>{formatDuration(row.duration)}{row.assignee ? ` · ${row.assignee}` : ""}{row.cue ? ` · ${row.cue}` : ""}</Text>
        </View>
      </View>
      <View style={departmentId === "all" ? styles.noteGrid : styles.focusedNoteWrap}>
        {visibleColumns.map((column) => {
          const note = noteFor(row, column.id);
          return (
            <Pressable accessibilityLabel={`Edit ${column.label} note for ${row.title}`} accessibilityRole="button" key={column.id} onPress={() => onEdit(row, column)} style={({ pressed }) => [departmentId === "all" ? styles.noteTile : styles.focusedNote, pressed && styles.notePressed]}>
              <View style={styles.noteHeading}>
                <Text numberOfLines={1} style={styles.noteDepartment}>{column.label}</Text>
                <Pencil color={colors.textFaint} size={14} />
              </View>
              <Text numberOfLines={departmentId === "all" ? 2 : 3} style={[styles.noteText, !note?.text && styles.emptyNote]}>{note?.text || "No instruction"}</Text>
            </Pressable>
          );
        })}
        {!visibleColumns.length ? <Text style={styles.noDepartments}>Add a department from settings to write notes.</Text> : null}
      </View>
    </View>
  );
}

function TabletCueRail({ rows, selectedRowId, onSelect }: { rows: CueRow[]; selectedRowId: string | null; onSelect: (rowId: string) => void }) {
  const styles = useStyles();
  return (
    <View style={styles.cueRail}>
      <Text style={styles.paneLabel}>CUES · {rows.length}</Text>
      <FlatList
        contentContainerStyle={styles.cueRailList}
        data={rows}
        keyExtractor={(row) => row.id}
        renderItem={({ item, index }) => (
          <Pressable accessibilityRole="button" accessibilityState={{ selected: item.id === selectedRowId }} onPress={() => onSelect(item.id)} style={({ pressed }) => [styles.railRow, item.id === selectedRowId && styles.railRowSelected, pressed && styles.pressed]}>
            <View style={styles.railNumberWrap}><Text style={styles.railNumber}>{index + 1}</Text><StatusDot status={item.status} /></View>
            <View style={styles.railCopy}>
              <Text numberOfLines={1} style={styles.railTitle}>{item.title}</Text>
              <Text numberOfLines={1} style={styles.railMeta}>{formatDuration(item.duration)}{item.assignee ? ` · ${item.assignee}` : ""}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

export default function CueSheetsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { height, width } = useWindowDimensions();
  const isTablet = width >= 900 && width > height;
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const previousIsTablet = useRef(isTablet);
  const [showId, setShowId] = useState<string>();
  const [showPickerOpen, setShowPickerOpen] = useState(false);
  const [departmentManagerOpen, setDepartmentManagerOpen] = useState(false);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [columnLabel, setColumnLabel] = useState("");
  const [selected, setSelected] = useState<EditorSelection | null>(null);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["mobile-cue-sheet", orgId, showId], queryFn: () => getMobileCueSheet(orgId!, showId), enabled: Boolean(orgId) });
  const mutation = useMutation({
    mutationFn: writeMobileCueSheet,
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({ queryKey: ["mobile-cue-sheet", orgId] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Cue sheet update failed."),
  });
  const data = query.data;
  const selectedRow = useMemo(() => data?.rows.find((row) => row.id === selected?.rowId) ?? null, [data?.rows, selected?.rowId]);
  const selectedColumn = useMemo(() => data?.columns.find((column) => column.id === selected?.columnId) ?? null, [data?.columns, selected?.columnId]);
  const activeRow = useMemo(() => data?.rows.find((row) => row.id === selectedRowId) ?? data?.rows[0] ?? null, [data?.rows, selectedRowId]);
  const activeDepartmentId = departmentId ?? data?.columns[0]?.id ?? "all";

  useEffect(() => {
    if (!showId && data?.show?.id) setShowId(data.show.id);
  }, [data?.show?.id, showId]);

  useEffect(() => {
    if (!data?.rows.length) {
      setSelectedRowId(null);
      return;
    }
    if (!selectedRowId || !data.rows.some((row) => row.id === selectedRowId)) setSelectedRowId(data.rows[0].id);
  }, [data?.rows, selectedRowId]);

  useEffect(() => {
    if (departmentId && departmentId !== "all" && !data?.columns.some((column) => column.id === departmentId)) setDepartmentId(null);
  }, [data?.columns, departmentId]);

  useEffect(() => {
    if (previousIsTablet.current && !isTablet) setSelected(null);
    previousIsTablet.current = isTablet;
  }, [isTablet]);

  useEffect(() => {
    if (!isTablet || !data?.canAddNotes || !activeRow || !data.columns.length) return;
    const column = data.columns.find((candidate) => candidate.id === selected?.columnId) ?? data.columns[0];
    if (selected?.rowId === activeRow.id && selected.columnId === column.id) return;
    setSelected({ rowId: activeRow.id, columnId: column.id, draft: noteFor(activeRow, column.id)?.text ?? "" });
  }, [activeRow, data?.canAddNotes, data?.columns, isTablet, selected?.columnId, selected?.rowId]);

  if (!orgId || query.isPending) return <LoadingView label="Opening cue sheet…" />;

  const write = (input: WriteInput, onSuccess?: () => void) => mutation.mutate({ orgId, ...input }, { onSuccess });
  const openEditor = (row: CueRow, column: CueColumn) => {
    setSelectedRowId(row.id);
    setSelected({ rowId: row.id, columnId: column.id, draft: noteFor(row, column.id)?.text ?? "" });
  };
  const saveSelected = () => {
    if (!data?.show || !selected) return;
    write({ action: "upsert-note", showId: data.show.id, itemId: selected.rowId, columnId: selected.columnId, text: selected.draft }, () => {
      if (!isTablet) setSelected(null);
    });
  };
  const resetSelectedDraft = () => {
    if (!selectedRow || !selectedColumn) return;
    setSelected({ rowId: selectedRow.id, columnId: selectedColumn.id, draft: noteFor(selectedRow, selectedColumn.id)?.text ?? "" });
  };
  const chooseShow = (nextShowId: string) => {
    setSelected(null);
    setSelectedRowId(null);
    setDepartmentId(null);
    setShowId(nextShowId);
    setShowPickerOpen(false);
  };

  return (
    <Page
      action={data?.canEdit ? <Pressable accessibilityLabel="Manage cue sheet departments" accessibilityRole="button" onPress={() => setDepartmentManagerOpen(true)} style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}><Settings2 color={colors.text} size={20} /></Pressable> : undefined}
      backLabel="Back to operations"
      backTo="/(app)/operations"
      maxWidth={1500}
      onRefresh={() => void query.refetch()}
      refreshing={query.isRefetching}
      scroll={false}
      subtitle={data?.show ? `${formatServiceDate(data.show.serviceDate)} · ${data.rows.length} cues` : "No scheduled show"}
      title="Cue sheet"
    >
      {query.error ? <OperationsError message={query.error.message} /> : null}
      {error ? <OperationsError message={error} /> : null}
      {data ? (
        <Pressable accessibilityLabel="Choose show" accessibilityRole="button" onPress={() => setShowPickerOpen(true)} style={({ pressed }) => [styles.showBar, pressed && styles.pressed]}>
          <View style={styles.showAccent} />
          <View style={styles.showBarCopy}>
            <Text numberOfLines={1} style={styles.showName}>{data.show?.name || data.show?.serviceDate || "Choose a show"}</Text>
            <Text style={styles.showMeta}>{data.show ? `${formatStartTime(data.show.scheduledStartTime)} · ${formatServiceDate(data.show.serviceDate)}` : "No rundown is available"}</Text>
          </View>
          <ChevronDown color={colors.textMuted} size={20} />
        </Pressable>
      ) : null}

      {!data?.show ? (
        <View style={styles.emptyState}><OperationsEmpty>Create a show and rundown before adding cue notes.</OperationsEmpty></View>
      ) : isTablet ? (
        <View style={styles.tabletWorkspace}>
          <TabletCueRail rows={data.rows} selectedRowId={activeRow?.id ?? null} onSelect={setSelectedRowId} />
          <ScrollView contentContainerStyle={styles.detailScroll} style={styles.detailPane}>
            {activeRow ? (
              <>
                <View style={styles.detailHeading}>
                  <View style={styles.detailStatus}><StatusDot status={activeRow.status} /><Text style={styles.detailStatusText}>{activeRow.status || "Ready"}</Text></View>
                  <Text style={styles.detailTitle}>{activeRow.title}</Text>
                  <Text style={styles.detailMeta}>{formatDuration(activeRow.duration)}{activeRow.assignee ? ` · ${activeRow.assignee}` : ""}{activeRow.type ? ` · ${activeRow.type}` : ""}</Text>
                  {activeRow.cue ? <Text style={styles.detailCue}>{activeRow.cue}</Text> : null}
                </View>
                <View style={styles.departmentCards}>
                  {data.columns.map((column) => {
                    const note = noteFor(activeRow, column.id);
                    const editing = selected?.rowId === activeRow.id && selected.columnId === column.id;
                    return (
                      <Pressable accessibilityLabel={`Edit ${column.label} note`} accessibilityRole="button" key={column.id} onPress={() => openEditor(activeRow, column)} style={({ pressed }) => [styles.departmentCard, editing && styles.departmentCardSelected, pressed && styles.notePressed]}>
                        <View style={styles.noteHeading}><Text numberOfLines={1} style={styles.departmentCardTitle}>{column.label}</Text><Pencil color={editing ? colors.amberText : colors.textFaint} size={15} /></View>
                        <Text style={[styles.departmentCardNote, !note?.text && styles.emptyNote]}>{note?.text || "No instruction"}</Text>
                      </Pressable>
                    );
                  })}
                  {!data.columns.length ? <OperationsEmpty>Add a department from settings to start writing notes.</OperationsEmpty> : null}
                </View>
              </>
            ) : <OperationsEmpty>No rundown cues are available for this show.</OperationsEmpty>}
          </ScrollView>
          <View style={styles.inspectorPane}>
            {selected && selectedRow && selectedColumn && data.canAddNotes ? (
              <NoteEditor column={selectedColumn} draft={selected.draft} onCancel={resetSelectedDraft} onChange={(draft) => setSelected((current) => current ? { ...current, draft } : null)} onSave={saveSelected} pending={mutation.isPending} row={selectedRow} />
            ) : (
              <View style={styles.inspectorEmpty}>
                <Pencil color={colors.textFaint} size={22} />
                <Text style={styles.inspectorEmptyTitle}>{data.canAddNotes ? "Select a department note" : "View only"}</Text>
                <Text style={styles.inspectorEmptyText}>{data.canAddNotes ? "Choose a note in the selected cue to edit it here." : "You can read this cue sheet, but you do not have permission to edit notes."}</Text>
              </View>
            )}
          </View>
        </View>
      ) : (
        <View style={styles.phoneWorkspace}>
          <ScrollView contentContainerStyle={styles.departmentFilters} horizontal showsHorizontalScrollIndicator={false}>
            <Pressable accessibilityRole="button" accessibilityState={{ selected: activeDepartmentId === "all" }} onPress={() => setDepartmentId("all")} style={({ pressed }) => [styles.filterButton, activeDepartmentId === "all" && styles.filterButtonActive, pressed && styles.pressed]}><Text style={[styles.filterText, activeDepartmentId === "all" && styles.filterTextActive]}>All</Text></Pressable>
            {data.columns.map((column) => (
              <Pressable accessibilityRole="button" accessibilityState={{ selected: activeDepartmentId === column.id }} key={column.id} onPress={() => setDepartmentId(column.id)} style={({ pressed }) => [styles.filterButton, activeDepartmentId === column.id && styles.filterButtonActive, pressed && styles.pressed]}><Text numberOfLines={1} style={[styles.filterText, activeDepartmentId === column.id && styles.filterTextActive]}>{column.label}</Text></Pressable>
            ))}
          </ScrollView>
          <FlatList contentContainerStyle={styles.phoneCueList} data={data.rows} keyExtractor={(row) => row.id} ListEmptyComponent={<OperationsEmpty>No rundown cues are available for this show.</OperationsEmpty>} renderItem={({ item, index }) => <PhoneCueRow columns={data.columns} departmentId={activeDepartmentId} index={index} onEdit={openEditor} row={item} />} />
        </View>
      )}

      {showPickerOpen && data ? <ShowPicker data={data} onClose={() => setShowPickerOpen(false)} onSelect={chooseShow} /> : null}
      {departmentManagerOpen && data ? (
        <DepartmentManager
          columnLabel={columnLabel}
          columns={data.columns}
          onAdd={() => write({ action: "add-column", label: columnLabel.trim(), color: "amber" }, () => setColumnLabel(""))}
          onChangeLabel={setColumnLabel}
          onClose={() => setDepartmentManagerOpen(false)}
          onMove={(column, sortOrder) => write({ action: "move-column", columnId: column.id, sortOrder })}
          onRemove={(column) => Alert.alert("Remove department?", `Remove “${column.label}” and every cue note in that department?`, [
            { text: "Cancel", style: "cancel" },
            { text: "Remove", style: "destructive", onPress: () => write({ action: "remove-column", columnId: column.id }, () => { if (selected?.columnId === column.id) setSelected(null); }) },
          ])}
          pending={mutation.isPending}
        />
      ) : null}
      {!isTablet && selected && selectedRow && selectedColumn && data?.canAddNotes ? (
        <Modal animationType="slide" onRequestClose={() => setSelected(null)} transparent visible>
          <View style={styles.sheetOverlay}>
            <Pressable accessibilityLabel="Close note editor" onPress={() => setSelected(null)} style={StyleSheet.absoluteFill} />
            <NoteEditor column={selectedColumn} compact draft={selected.draft} onCancel={() => setSelected(null)} onChange={(draft) => setSelected((current) => current ? { ...current, draft } : null)} onSave={saveSelected} pending={mutation.isPending} row={selectedRow} />
          </View>
        </Modal>
      ) : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  pressed: { opacity: 0.68 },
  disabled: { opacity: 0.36 },
  headerAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  showBar: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12, overflow: "hidden", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingRight: 14 },
  showAccent: { alignSelf: "stretch", width: 3, backgroundColor: colors.amber },
  showBarCopy: { flex: 1, minWidth: 0, gap: 2, paddingVertical: 9 },
  showName: { color: colors.text, fontFamily, fontSize: 15, lineHeight: 20, fontWeight: "800" },
  showMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  emptyState: { flex: 1, justifyContent: "center" },
  phoneWorkspace: { flex: 1, minHeight: 0, gap: 9 },
  departmentFilters: { gap: 8, paddingVertical: 1, paddingRight: 12 },
  filterButton: { minWidth: 66, height: 42, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 16 },
  filterButtonActive: { borderColor: colors.amber, backgroundColor: colors.amber },
  filterText: { color: colors.textMuted, fontFamily, fontSize: 13, fontWeight: "700" },
  filterTextActive: { color: colors.black },
  phoneCueList: { paddingBottom: 28 },
  phoneCueRow: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingVertical: 13, gap: 11 },
  cueIdentity: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 10 },
  cueNumber: { width: 24, color: colors.textMuted, fontFamily, fontSize: 13, fontVariant: ["tabular-nums"], textAlign: "center" },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusComplete: { backgroundColor: colors.green },
  statusLive: { backgroundColor: colors.amber },
  statusReady: { backgroundColor: colors.textFaint },
  cueCopy: { flex: 1, minWidth: 0, gap: 2 },
  cueTitle: { color: colors.text, fontFamily, fontSize: 15, lineHeight: 20, fontWeight: "800" },
  cueMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  noteGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingLeft: 44 },
  focusedNoteWrap: { paddingLeft: 44 },
  noteTile: { width: "48%", minWidth: 142, flexGrow: 1, gap: 5, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 10 },
  focusedNote: { minHeight: 68, gap: 5, borderLeftWidth: 2, borderLeftColor: colors.amber, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 10 },
  notePressed: { opacity: 0.68, borderColor: colors.amberBorder },
  noteHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  noteDepartment: { flex: 1, color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 15, fontWeight: "800", textTransform: "uppercase" },
  noteText: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 18 },
  emptyNote: { color: colors.textFaint, fontStyle: "italic" },
  noDepartments: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18, paddingVertical: 8 },
  tabletWorkspace: { flex: 1, minHeight: 0, flexDirection: "row", overflow: "hidden", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised },
  cueRail: { width: 270, borderRightWidth: 1, borderRightColor: colors.border, backgroundColor: colors.stageRaised },
  paneLabel: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "800", letterSpacing: 1.1, paddingHorizontal: 15, paddingVertical: 13 },
  cueRailList: { paddingBottom: 18 },
  railRow: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingHorizontal: 13, paddingVertical: 10 },
  railRowSelected: { borderLeftWidth: 3, borderLeftColor: colors.amber, backgroundColor: colors.panelStrong, paddingLeft: 10 },
  railNumberWrap: { width: 32, alignItems: "center", gap: 6 },
  railNumber: { color: colors.textMuted, fontFamily, fontSize: 12, fontVariant: ["tabular-nums"] },
  railCopy: { flex: 1, minWidth: 0, gap: 3 },
  railTitle: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, fontWeight: "800" },
  railMeta: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16 },
  detailPane: { flex: 1, minWidth: 320 },
  detailScroll: { padding: spacing.large, gap: spacing.large },
  detailHeading: { gap: 7, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.large },
  detailStatus: { flexDirection: "row", alignItems: "center", gap: 7 },
  detailStatusText: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  detailTitle: { color: colors.text, fontFamily, fontSize: 30, lineHeight: 36, fontWeight: "900", letterSpacing: -0.7 },
  detailMeta: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 20 },
  detailCue: { color: colors.text, fontFamily, fontSize: 15, lineHeight: 22, marginTop: 5 },
  departmentCards: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", gap: 10 },
  departmentCard: { minWidth: 190, maxWidth: 300, minHeight: 142, flexBasis: 190, flexGrow: 1, gap: 12, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 14 },
  departmentCardSelected: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  departmentCardTitle: { flex: 1, color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  departmentCardNote: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 21 },
  inspectorPane: { width: 300, borderLeftWidth: 1, borderLeftColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  inspectorEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 18 },
  inspectorEmptyTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800", textAlign: "center" },
  inspectorEmptyText: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
  editor: { flex: 1, gap: spacing.medium },
  editorCompact: { flex: 0, maxHeight: "86%", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.medium, paddingBottom: 28 },
  editorHeading: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  editorCopy: { flex: 1, minWidth: 0, gap: 3 },
  editorTitle: { color: colors.text, fontFamily, fontSize: 17, lineHeight: 22, fontWeight: "900" },
  editorMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  compactClose: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: colors.panel },
  noteField: { minHeight: 126, paddingTop: 13, textAlignVertical: "top" },
  noteFieldTall: { minHeight: 220 },
  editorActions: { flexDirection: "row", gap: 8 },
  actionButton: { flex: 1 },
  sheetOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalPage: { flex: 1, backgroundColor: colors.stage, padding: spacing.medium },
  modalHeader: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 12 },
  modalHeading: { flex: 1, minWidth: 0, gap: 2 },
  modalTitle: { color: colors.text, fontFamily, fontSize: 21, lineHeight: 27, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  dangerIconButton: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  modalList: { gap: 8, paddingVertical: 14 },
  showOption: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, paddingHorizontal: 14, paddingVertical: 10 },
  showOptionActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  showOptionCopy: { flex: 1, minWidth: 0, gap: 3 },
  showOptionTitle: { color: colors.text, fontFamily, fontSize: 15, lineHeight: 20, fontWeight: "800" },
  showOptionMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  activeMark: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.amber },
  addDepartment: { flexDirection: "row", alignItems: "flex-end", gap: 9, paddingVertical: 14 },
  addDepartmentField: { flex: 1 },
  addButton: { width: 52, height: 52, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, backgroundColor: colors.amber },
  departmentList: { paddingBottom: 24 },
  departmentRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingVertical: 9 },
  departmentCopy: { flex: 1, minWidth: 0, gap: 2 },
  departmentTitle: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  departmentMeta: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16 },
}));
