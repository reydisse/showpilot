import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createMobileAudioAssignment, getMobileAudio, removeMobileAudioAssignment, updateMobileAudioAssignment, type MobileAudioAssignment, type MobileAudioWrite } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

const emptyDraft = { channel: "1", label: "", micType: "wireless-handheld", micModel: "", notes: "", gainDb: "", phantom: false, muted: false, group: "vocals", mixerConsole: "", mixerChannel: "", mixerChannelType: "input" };

export default function AudioScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [showId, setShowId] = useState<string>();
  const [editing, setEditing] = useState<MobileAudioAssignment | "new" | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
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
  return (
    <Page eyebrow="PATCH AND INPUTS" title="Audio" refreshing={query.isRefetching} onRefresh={() => void query.refetch()} action={query.data?.show ? <View style={styles.headerAction}><AppButton label="Add" onPress={() => { setEditing("new"); setDraft({ ...emptyDraft, channel: String((query.data?.assignments.at(-1)?.channel ?? 0) + 1) }); }} /></View> : undefined}>
      {query.error ? <OperationsError message={query.error.message} /> : null}{error ? <OperationsError message={error} /> : null}
      <OperationsPanel title={query.data?.show?.name || query.data?.show?.serviceDate || "No show"} detail={`${query.data?.assignments.length ?? 0} patched inputs · ${query.data?.mixers.length ?? 0} mixer devices`}>
        <View style={styles.wrap}>{query.data?.shows.map((show) => <View key={show.id} style={styles.showButton}><AppButton label={show.name || show.serviceDate} variant={show.id === query.data?.show?.id ? "primary" : "secondary"} onPress={() => setShowId(show.id)} /></View>)}</View>
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
    </Page>
  );
}
const useStyles = createThemedStyles(() => StyleSheet.create({ headerAction: { width: 88 }, wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, showButton: { minWidth: 130, flexGrow: 1 }, buttonRow: { flexDirection: "row", gap: 8 }, flex: { flex: 1 }, notes: { minHeight: 88, paddingTop: 13, textAlignVertical: "top" } }));
