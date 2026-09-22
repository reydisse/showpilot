import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Search from "lucide-react-native/icons/search";
import X from "lucide-react-native/icons/x";
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createMobileAudioAssignment, getMobileAudio, removeMobileAudioAssignment, updateMobileAudioAssignment, type MobileAudioAssignment, type MobileAudioWrite } from "@/lib/mobile-api";
import { formatServiceTime } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const emptyDraft = { channel: "1", label: "", micType: "wireless-handheld", micModel: "", notes: "", gainDb: "", phantom: false, muted: false, group: "vocals", mixerConsole: "", mixerChannel: "", mixerChannelType: "input" };

export default function AudioScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization, data: bootstrap } = useMobileBootstrap();
  const orgId = organization?.id;
  const [showId, setShowId] = useState<string>();
  const [editing, setEditing] = useState<MobileAudioAssignment | "new" | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const [showPickerOpen, setShowPickerOpen] = useState(false);
  const [showSearch, setShowSearch] = useState("");
  const query = useQuery({ queryKey: ["mobile-audio", orgId, showId], queryFn: () => getMobileAudio(orgId!, showId), enabled: Boolean(orgId) });
  useEffect(() => { if (!showId && query.data?.show?.id) setShowId(query.data.show.id); }, [query.data?.show?.id, showId]);
  const mutation = useMutation({
    mutationFn: async (input: { kind: "save"; id?: string; value: MobileAudioWrite } | { kind: "remove"; id: string }) => input.kind === "remove" ? removeMobileAudioAssignment({ orgId: orgId!, id: input.id }) : input.id ? updateMobileAudioAssignment({ ...input.value, id: input.id }) : createMobileAudioAssignment(input.value),
    onSuccess: async () => { setEditing(null); setDraft(emptyDraft); setError(""); await queryClient.invalidateQueries({ queryKey: ["mobile-audio", orgId] }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Audio assignment update failed."),
  });
  if (!orgId || query.isPending) return <LoadingView label="Opening audio plan…" />;
  const beginEdit = (assignment: MobileAudioAssignment) => { setEditing(assignment); setDraft({ channel: String(assignment.channel), label: assignment.label, micType: assignment.micType, micModel: assignment.micModel, notes: assignment.notes, gainDb: assignment.gainDb === null ? "" : String(assignment.gainDb), phantom: assignment.phantom, muted: assignment.muted, group: assignment.group, mixerConsole: assignment.mixerConsole, mixerChannel: assignment.mixerChannel === null ? "" : String(assignment.mixerChannel), mixerChannelType: assignment.mixerChannelType }); };
  const save = () => {
    const targetShowId = showId ?? query.data?.show?.id;
    const channel = Number(draft.channel);
    const gainDb = draft.gainDb ? Number(draft.gainDb) : null;
    const mixerChannel = draft.mixerChannel ? Number(draft.mixerChannel) : null;
    if (!targetShowId || !Number.isInteger(channel) || channel < 1 || channel > 512) { setError("Choose a show and enter a channel from 1 to 512."); return; }
    if ((gainDb !== null && (!Number.isFinite(gainDb) || gainDb < -200 || gainDb > 200)) || (mixerChannel !== null && (!Number.isInteger(mixerChannel) || mixerChannel < 0 || mixerChannel > 10_000))) {
      setError("Gain must be from -200 to 200 dB and mixer channel must be a whole number.");
      return;
    }
    mutation.mutate({ kind: "save", id: editing === "new" || editing === null ? undefined : editing.id, value: { orgId, showId: targetShowId, channel, label: draft.label, micType: draft.micType, micModel: draft.micModel, notes: draft.notes, gainDb, phantom: draft.phantom, muted: draft.muted, group: draft.group, mixerConsole: draft.mixerConsole, mixerChannel, mixerChannelType: draft.mixerChannelType } });
  };
  const selectShow = (nextShowId: string) => {
    const apply = () => {
      setEditing(null);
      setDraft(emptyDraft);
      setError("");
      setShowId(nextShowId);
      setShowPickerOpen(false);
    };
    if (!editing) {
      apply();
      return;
    }
    Alert.alert(
      "Discard unsaved input changes?",
      "Your current input draft belongs to this show.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard and switch", style: "destructive", onPress: apply },
      ],
    );
  };
  const normalizedShowSearch = showSearch.trim().toLowerCase();
  const visibleShows = (query.data?.shows ?? []).filter((show) => !normalizedShowSearch
    || `${show.name} ${show.serviceDate} ${show.scheduledStartTime ?? ""}`.toLowerCase().includes(normalizedShowSearch));
  const selectedShow = query.data?.show;
  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="PATCH AND INPUTS" title="Audio" refreshing={query.isRefetching} onRefresh={() => void query.refetch()} action={query.data?.show ? <View style={styles.headerAction}><AppButton label="Add" onPress={() => { setEditing("new"); setDraft({ ...emptyDraft, channel: String((query.data?.assignments.at(-1)?.channel ?? 0) + 1) }); }} /></View> : undefined}>
      {query.error ? <OperationsError message={query.error.message} /> : null}{error ? <OperationsError message={error} /> : null}
      <OperationsPanel title={selectedShow?.name || selectedShow?.serviceDate || "No show"} detail={selectedShow ? `${selectedShow.serviceDate} · ${formatServiceTime(selectedShow.scheduledStartTime ?? null, bootstrap?.timeZone ?? "UTC")} · ${query.data?.assignments.length ?? 0} patched inputs · ${query.data?.mixers.length ?? 0} mixer devices` : "Choose a show to begin patching inputs."}>
        <AppButton label="Change show" variant="secondary" onPress={() => setShowPickerOpen(true)} />
      </OperationsPanel>
      {editing ? <OperationsPanel title={editing === "new" ? "Add input" : `Edit channel ${editing.channel}`}>
        <View style={styles.buttonRow}><View style={styles.flex}><AppField label="Channel" value={draft.channel} onChangeText={(channel) => setDraft({ ...draft, channel })} keyboardType="number-pad" /></View><View style={styles.flex}><AppField label="Label" value={draft.label} onChangeText={(label) => setDraft({ ...draft, label })} /></View></View>
        <AppField label="Mic type" value={draft.micType} onChangeText={(micType) => setDraft({ ...draft, micType: micType.toLowerCase() })} placeholder="wireless-handheld, lav, wired…" />
        <AppField label="Mic model" value={draft.micModel} onChangeText={(micModel) => setDraft({ ...draft, micModel })} />
        <AppField label="Group" value={draft.group} onChangeText={(group) => setDraft({ ...draft, group: group.toLowerCase() })} placeholder="vocals, band, playback, sfx, other" />
        <View style={styles.buttonRow}><View style={styles.flex}><AppButton label={draft.muted ? "Muted" : "Open"} variant={draft.muted ? "danger" : "secondary"} onPress={() => setDraft({ ...draft, muted: !draft.muted })} /></View><View style={styles.flex}><AppButton label={draft.phantom ? "48V on" : "48V off"} variant={draft.phantom ? "primary" : "secondary"} onPress={() => setDraft({ ...draft, phantom: !draft.phantom })} /></View></View>
        <View style={styles.buttonRow}><View style={styles.flex}><AppField label="Gain dB" value={draft.gainDb} onChangeText={(gainDb) => setDraft({ ...draft, gainDb })} keyboardType="numbers-and-punctuation" /></View><View style={styles.flex}><AppField label="Mixer channel" value={draft.mixerChannel} onChangeText={(mixerChannel) => setDraft({ ...draft, mixerChannel })} keyboardType="number-pad" /></View></View>
        <AppField label="Mixer console" value={draft.mixerConsole} onChangeText={(mixerConsole) => setDraft({ ...draft, mixerConsole })} />
        <AppField label="Notes" value={draft.notes} onChangeText={(notes) => setDraft({ ...draft, notes })} multiline style={styles.notes} />
        <View style={styles.buttonRow}><View style={styles.flex}><AppButton label="Cancel" variant="secondary" onPress={() => setEditing(null)} /></View><View style={styles.flex}><AppButton label="Save input" loading={mutation.isPending} disabled={!draft.label.trim()} onPress={save} /></View></View>
        {editing !== "new" ? <AppButton label="Delete input" variant="danger" onPress={() => Alert.alert("Delete audio input?", `Permanently remove channel ${editing.channel}, “${editing.label}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => mutation.mutate({ kind: "remove", id: editing.id }) }])} /> : null}
      </OperationsPanel> : null}
      <OperationsPanel title="Input list" detail="Tap a channel to edit its patch, gain, power, or mute state.">
        {query.data?.assignments.length ? query.data.assignments.map((assignment) => <OperationsRow key={assignment.id} title={`${assignment.channel}. ${assignment.label}`} detail={[assignment.micType, assignment.group, assignment.mixerConsole && `${assignment.mixerConsole} ${assignment.mixerChannel ?? ""}`].filter(Boolean).join(" · ")} status={assignment.muted ? "Muted" : assignment.phantom ? "48V" : "Open"} onPress={() => beginEdit(assignment)} />) : <OperationsEmpty>No audio inputs are assigned to this show.</OperationsEmpty>}
      </OperationsPanel>
      <Modal animationType="slide" onRequestClose={() => setShowPickerOpen(false)} transparent visible={showPickerOpen}>
        <View style={styles.modalBackdrop}>
          <View style={styles.showPicker}>
            <View style={styles.showPickerHeader}>
              <View style={styles.showPickerTitleWrap}><Text style={styles.showPickerEyebrow}>AUDIO PLAN</Text><Text style={styles.showPickerTitle}>Choose a show</Text></View>
              <Pressable accessibilityLabel="Close show picker" accessibilityRole="button" onPress={() => setShowPickerOpen(false)} style={styles.closeButton}><X color={colors.textMuted} size={21} /></Pressable>
            </View>
            <View style={styles.searchRow}><Search color={colors.textFaint} size={18} /><TextInput accessibilityLabel="Search shows" onChangeText={setShowSearch} placeholder="Search title or date" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={showSearch} /></View>
            <FlatList
              data={visibleShows}
              keyExtractor={(show) => show.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const selected = item.id === selectedShow?.id;
                return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => selectShow(item.id)} style={[styles.showChoice, selected && styles.showChoiceSelected]}><Text style={[styles.showChoiceTitle, selected && styles.showChoiceTitleSelected]}>{item.name || "Untitled show"}</Text><Text style={styles.showChoiceMeta}>{item.serviceDate} · {formatServiceTime(item.scheduledStartTime ?? null, bootstrap?.timeZone ?? "UTC")}</Text></Pressable>;
              }}
              ListEmptyComponent={<OperationsEmpty>No shows match this search.</OperationsEmpty>}
              style={styles.showList}
            />
          </View>
        </View>
      </Modal>
    </Page>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({
  headerAction: { width: 88 },
  buttonRow: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  notes: { minHeight: 88, paddingTop: 13, textAlignVertical: "top" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  showPicker: { maxHeight: "82%", gap: spacing.medium, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  showPickerHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  showPickerTitleWrap: { flex: 1, gap: 3 },
  showPickerEyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  showPickerTitle: { color: colors.text, fontFamily, fontSize: 22, fontWeight: "900" },
  closeButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 21, backgroundColor: colors.panelStrong },
  searchRow: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stage, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 14, paddingVertical: 10 },
  showList: { minHeight: 120 },
  showChoice: { gap: 4, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, paddingHorizontal: 12, paddingVertical: 14 },
  showChoiceSelected: { borderRadius: radii.medium, borderBottomColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  showChoiceTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  showChoiceTitleSelected: { color: colors.amberText },
  showChoiceMeta: { color: colors.textMuted, fontFamily, fontSize: 12 },
}));
