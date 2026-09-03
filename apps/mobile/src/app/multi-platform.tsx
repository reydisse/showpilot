import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { commandMobileDestination, createMobileDestination, getMobileStreaming, updateMobileDestination, type MobileDestinationWrite, type MobileStreaming } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

const emptyDestination = { name: "", platform: "youtube", rtmpUrl: "rtmps://", streamKey: "" };
type Destination = MobileStreaming["destinations"][number];

export default function MultiPlatformScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [editing, setEditing] = useState<Destination | "new" | null>(null);
  const [draft, setDraft] = useState(emptyDestination);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["mobile-streaming", orgId], queryFn: () => getMobileStreaming(orgId!), enabled: Boolean(orgId), refetchInterval: 5_000 });
  const mutation = useMutation({
    mutationFn: async (input: { kind: "save"; id?: string; value: MobileDestinationWrite } | { kind: "command"; id: string; action: "toggle" | "remove"; enabled?: boolean }) => input.kind === "save" ? input.id ? updateMobileDestination({ ...input.value, id: input.id }) : createMobileDestination(input.value) : commandMobileDestination({ orgId: orgId!, id: input.id, action: input.action, enabled: input.enabled }),
    onSuccess: async () => { setEditing(null); setDraft(emptyDestination); setError(""); await queryClient.invalidateQueries({ queryKey: ["mobile-streaming", orgId] }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Destination update failed."),
  });
  if (!orgId || query.isPending) return <LoadingView label="Opening multi-platform streaming…" />;
  const beginEdit = (destination: Destination) => { setEditing(destination); setDraft({ name: destination.name, platform: destination.platform, rtmpUrl: destination.rtmpUrl, streamKey: "" }); };
  const save = () => mutation.mutate({ kind: "save", id: editing === "new" || editing === null ? undefined : editing.id, value: { orgId, ...draft } });
  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="STREAM CONNECT" title="Multi-Platform" refreshing={query.isRefetching} onRefresh={() => void query.refetch()} action={query.data?.canManage ? <View style={styles.headerAction}><AppButton label="Add" onPress={() => { setEditing("new"); setDraft(emptyDestination); }} /></View> : undefined}>
      {query.error ? <OperationsError message={query.error.message} /> : null}{error ? <OperationsError message={error} /> : null}
      {editing ? <OperationsPanel title={editing === "new" ? "Add destination" : `Edit ${editing.name}`} detail="Stream keys are write-only and never returned to the app.">
        <AppField label="Name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
        <AppField label="Platform" value={draft.platform} onChangeText={(platform) => setDraft({ ...draft, platform: platform.toLowerCase() })} placeholder="youtube, facebook, twitch, custom" />
        <AppField label="RTMP URL" value={draft.rtmpUrl} onChangeText={(rtmpUrl) => setDraft({ ...draft, rtmpUrl })} autoCapitalize="none" />
        <AppField label={editing === "new" ? "Stream key" : "New stream key (leave blank to keep current)"} value={draft.streamKey} onChangeText={(streamKey) => setDraft({ ...draft, streamKey })} secureTextEntry autoCorrect={false} />
        <View style={styles.buttonRow}><View style={styles.flex}><AppButton label="Cancel" variant="secondary" onPress={() => setEditing(null)} /></View><View style={styles.flex}><AppButton label="Save" loading={mutation.isPending} disabled={!draft.name.trim() || !draft.rtmpUrl.trim() || (editing === "new" && !draft.streamKey.trim())} onPress={save} /></View></View>
        {editing !== "new" ? <AppButton label="Delete destination" variant="danger" onPress={() => Alert.alert("Delete destination?", `Disconnect and permanently remove “${editing.name}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => mutation.mutate({ kind: "command", id: editing.id, action: "remove" }) }])} /> : null}
      </OperationsPanel> : null}
      <OperationsPanel title="Destinations" detail="Tap a destination to edit its metadata and credentials.">
        {query.data?.destinations.length ? query.data.destinations.map((destination) => <View key={destination.id} style={styles.destination}><OperationsRow title={destination.name} detail={`${destination.platform} · ${destination.hasStreamKey ? "key stored" : "key missing"}`} status={!destination.enabled ? "Disabled" : destination.connected ? "Connected" : "Ready"} onPress={query.data.canManage ? () => beginEdit(destination) : undefined} />{query.data.canManage ? <AppButton label={destination.enabled ? "Disable output" : "Enable output"} variant="secondary" onPress={() => mutation.mutate({ kind: "command", id: destination.id, action: "toggle", enabled: !destination.enabled })} /> : null}</View>) : <OperationsEmpty>No destinations are configured.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({ headerAction: { width: 88 }, buttonRow: { flexDirection: "row", gap: 8 }, flex: { flex: 1 }, destination: { gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft, paddingBottom: 12 } }));
