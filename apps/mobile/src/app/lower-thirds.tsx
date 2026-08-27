import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { commandMobileGraphic, createMobileGraphic, getMobileGraphics, updateMobileGraphic, type MobileGraphicWrite, type MobileGraphics } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

const emptyGraphic = { name: "", title: "", subtitle: "" };
type Graphic = MobileGraphics["templates"][number];

export default function LowerThirdsScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [editing, setEditing] = useState<Graphic | "new" | null>(null);
  const [draft, setDraft] = useState(emptyGraphic);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["mobile-graphics", orgId], queryFn: () => getMobileGraphics(orgId!), enabled: Boolean(orgId), refetchInterval: 2_000 });
  const mutation = useMutation({
    mutationFn: async (input: { kind: "save"; id?: string; value: MobileGraphicWrite } | { kind: "command"; id?: string; action: "toggle" | "clear" | "remove" }) => input.kind === "save" ? input.id ? updateMobileGraphic({ ...input.value, id: input.id }) : createMobileGraphic(input.value) : commandMobileGraphic({ orgId: orgId!, id: input.id, action: input.action }),
    onSuccess: async () => { setEditing(null); setDraft(emptyGraphic); setError(""); await queryClient.invalidateQueries({ queryKey: ["mobile-graphics", orgId] }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Graphics command failed."),
  });
  if (!orgId || query.isPending) return <LoadingView label="Opening lower thirds…" />;
  const beginEdit = (graphic: Graphic) => { setEditing(graphic); setDraft({ name: graphic.name, title: graphic.title, subtitle: graphic.subtitle }); };
  const save = () => mutation.mutate({ kind: "save", id: editing === "new" || editing === null ? undefined : editing.id, value: { orgId, ...draft } });
  return (
    <Page eyebrow="ON-AIR GRAPHICS" title="Lower Thirds" refreshing={query.isRefetching} onRefresh={() => void query.refetch()} action={query.data?.canConfigure ? <View style={styles.headerAction}><AppButton label="Add" onPress={() => { setEditing("new"); setDraft(emptyGraphic); }} /></View> : undefined}>
      {query.error ? <OperationsError message={query.error.message} /> : null}{error ? <OperationsError message={error} /> : null}
      {!query.data?.cloudEnabled ? <OperationsError message="Cloud graphics are disabled for this organization. Enable them in organization settings before going live." /> : null}
      {editing ? <OperationsPanel title={editing === "new" ? "Create lower third" : `Edit ${editing.name}`}>
        <AppField label="Template name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
        <AppField label="Title" value={draft.title} onChangeText={(title) => setDraft({ ...draft, title })} />
        <AppField label="Subtitle" value={draft.subtitle} onChangeText={(subtitle) => setDraft({ ...draft, subtitle })} />
        <View style={styles.buttonRow}><View style={styles.flex}><AppButton label="Cancel" variant="secondary" onPress={() => setEditing(null)} /></View><View style={styles.flex}><AppButton label="Save" loading={mutation.isPending} disabled={!draft.name.trim() || !draft.title.trim()} onPress={save} /></View></View>
        {editing !== "new" ? <AppButton label="Delete template" variant="danger" onPress={() => Alert.alert("Delete lower third?", `Permanently remove “${editing.name}”?`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => mutation.mutate({ kind: "command", id: editing.id, action: "remove" }) }])} /> : null}
      </OperationsPanel> : null}
      <OperationsPanel title="Graphics library" detail={`${query.data?.activeIds.length ?? 0} live`} action={query.data?.canTrigger && query.data.activeIds.length ? <View style={styles.clearAction}><AppButton label="Clear all" variant="danger" onPress={() => Alert.alert("Clear all graphics?", "Take every active lower third off air?", [{ text: "Keep live", style: "cancel" }, { text: "Clear all", style: "destructive", onPress: () => mutation.mutate({ kind: "command", action: "clear" }) }])} /></View> : undefined}>
        {query.data?.templates.length ? query.data.templates.map((graphic) => <View key={graphic.id} style={styles.graphic}><OperationsRow title={graphic.title} detail={[graphic.name, graphic.subtitle].filter(Boolean).join(" · ")} status={query.data.activeIds.includes(graphic.id) ? "Live" : "Ready"} onPress={query.data.canConfigure ? () => beginEdit(graphic) : undefined} />{query.data.canTrigger ? <AppButton label={query.data.activeIds.includes(graphic.id) ? "Take off air" : "Take live"} variant={query.data.activeIds.includes(graphic.id) ? "danger" : "primary"} onPress={() => mutation.mutate({ kind: "command", id: graphic.id, action: "toggle" })} /> : null}</View>) : <OperationsEmpty>No lower-third templates are available.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}
const useStyles = createThemedStyles((colors) => StyleSheet.create({ headerAction: { width: 88 }, clearAction: { width: 105 }, buttonRow: { flexDirection: "row", gap: 8 }, flex: { flex: 1 }, graphic: { gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft, paddingBottom: 12 } }));
