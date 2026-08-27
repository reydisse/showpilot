import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createMobileAsset, getMobileAssets, removeMobileAsset, updateMobileAsset, type MobileAsset, type MobileAssetWrite } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

const emptyAsset = { name: "", category: "audio", status: "operational", location: "", serialNumber: "", notes: "" };

export default function AssetInventoryScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MobileAsset | "new" | null>(null);
  const [draft, setDraft] = useState(emptyAsset);
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["mobile-assets", orgId], queryFn: () => getMobileAssets(orgId!), enabled: Boolean(orgId) });
  const mutation = useMutation({
    mutationFn: async (input: { kind: "save"; id?: string; value: MobileAssetWrite } | { kind: "remove"; id: string }) => {
      if (input.kind === "remove") return removeMobileAsset({ orgId: orgId!, id: input.id });
      return input.id ? updateMobileAsset({ ...input.value, id: input.id }) : createMobileAsset(input.value);
    },
    onSuccess: async () => {
      setEditing(null); setDraft(emptyAsset); setError("");
      await queryClient.invalidateQueries({ queryKey: ["mobile-assets", orgId] });
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Asset update failed."),
  });
  const filtered = useMemo(() => query.data?.assets.filter((asset) => `${asset.name} ${asset.category} ${asset.location} ${asset.serialNumber}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [], [query.data?.assets, search]);
  if (!orgId || query.isPending) return <LoadingView label="Opening asset inventory…" />;

  const beginEdit = (asset: MobileAsset) => {
    setEditing(asset);
    setDraft({ name: asset.name, category: asset.category, status: asset.status, location: asset.location, serialNumber: asset.serialNumber, notes: asset.notes });
  };
  const save = () => mutation.mutate({ kind: "save", id: editing === "new" || editing === null ? undefined : editing.id, value: { orgId, ...draft } });

  return (
    <Page eyebrow="PRODUCTION LIBRARY" title="Assets" refreshing={query.isRefetching} onRefresh={() => void query.refetch()} action={query.data?.canManage ? <View style={styles.headerAction}><AppButton label="Add" onPress={() => { setEditing("new"); setDraft(emptyAsset); }} /></View> : undefined}>
      {query.error ? <OperationsError message={query.error.message} /> : null}
      {error ? <OperationsError message={error} /> : null}
      <AppField label="Search inventory" value={search} onChangeText={setSearch} placeholder="Name, category, location, or serial" />
      {editing ? (
        <OperationsPanel title={editing === "new" ? "Add asset" : `Edit ${editing.name}`} detail="Status changes flow into the technical-manager readiness dashboard.">
          <AppField label="Name" value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} />
          <AppField label="Category" value={draft.category} onChangeText={(category) => setDraft({ ...draft, category: category.toLowerCase() })} placeholder="audio, video, lighting…" />
          <AppField label="Status" value={draft.status} onChangeText={(status) => setDraft({ ...draft, status: status.toLowerCase() })} placeholder="operational, maintenance, broken, retired" />
          <AppField label="Location" value={draft.location} onChangeText={(location) => setDraft({ ...draft, location })} />
          <AppField label="Serial number" value={draft.serialNumber} onChangeText={(serialNumber) => setDraft({ ...draft, serialNumber })} />
          <AppField label="Notes" value={draft.notes} onChangeText={(notes) => setDraft({ ...draft, notes })} multiline style={styles.notes} />
          <View style={styles.buttonRow}><View style={styles.flex}><AppButton label="Cancel" variant="secondary" onPress={() => setEditing(null)} /></View><View style={styles.flex}><AppButton label="Save asset" loading={mutation.isPending} disabled={!draft.name.trim()} onPress={save} /></View></View>
          {editing !== "new" ? <AppButton label="Delete asset" variant="danger" disabled={mutation.isPending} onPress={() => Alert.alert("Delete asset?", `Permanently remove “${editing.name}” from the shared inventory?`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => mutation.mutate({ kind: "remove", id: editing.id }) }])} /> : null}
        </OperationsPanel>
      ) : null}
      <OperationsPanel title="Inventory" detail={`${filtered.length} of ${query.data?.assets.length ?? 0} assets`}>
        {filtered.length ? filtered.map((asset) => <OperationsRow key={asset.id} title={asset.name} detail={[asset.category, asset.location, asset.serialNumber].filter(Boolean).join(" · ")} status={asset.status} onPress={query.data?.canManage ? () => beginEdit(asset) : undefined} />) : <OperationsEmpty>No assets match this view.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}

const useStyles = createThemedStyles(() => StyleSheet.create({
  headerAction: { width: 88 },
  notes: { minHeight: 88, paddingTop: 13, textAlignVertical: "top" },
  buttonRow: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
}));
