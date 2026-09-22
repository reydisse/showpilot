import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import {
  OperationsEmpty,
  OperationsError,
  OperationsPanel,
  OperationsRow,
} from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import {
  createMobileAsset,
  getMobileAssets,
  removeMobileAsset,
  updateMobileAsset,
  type MobileAsset,
  type MobileAssetWrite,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii } from "@/theme/tokens";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
  equipmentCategoryLabel,
  equipmentStatusLabel,
  isEquipmentCategory,
  isEquipmentStatus,
  type EquipmentCategory,
  type EquipmentStatus,
} from "@showpilot/shared";

type AssetDraft = Omit<MobileAssetWrite, "orgId" | "category" | "status"> & {
  category: string;
  status: string;
};

const emptyAsset: AssetDraft = {
  name: "",
  category: "audio",
  status: "operational",
  location: "",
  serialNumber: "",
  notes: "",
};

export default function AssetInventoryScreen() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MobileAsset | "new" | null>(null);
  const [draft, setDraft] = useState(emptyAsset);
  const [error, setError] = useState("");
  const query = useQuery({
    queryKey: ["mobile-assets", orgId],
    queryFn: () => getMobileAssets(orgId!),
    enabled: Boolean(orgId),
  });
  const mutation = useMutation({
    mutationFn: async (
      input:
        | {
            kind: "save";
            id?: string;
            expectedRevision?: number;
            value: MobileAssetWrite;
          }
        | { kind: "remove"; id: string; expectedRevision: number },
    ) => {
      if (input.kind === "remove")
        return removeMobileAsset({
          orgId: orgId!,
          id: input.id,
          expectedRevision: input.expectedRevision,
        });
      return input.id
        ? updateMobileAsset({
            ...input.value,
            id: input.id,
            expectedRevision: input.expectedRevision!,
          })
        : createMobileAsset(input.value);
    },
    onSuccess: async () => {
      setEditing(null);
      setDraft(emptyAsset);
      setError("");
      await queryClient.invalidateQueries({
        queryKey: ["mobile-assets", orgId],
      });
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : "Asset update failed."),
  });
  const filtered = useMemo(
    () =>
      query.data?.assets.filter((asset) =>
        `${asset.name} ${asset.category} ${asset.location} ${asset.serialNumber}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ) ?? [],
    [query.data?.assets, search],
  );
  if (!orgId || query.isPending)
    return <LoadingView label="Opening asset inventory…" />;

  const beginEdit = (asset: MobileAsset) => {
    setEditing(asset);
    setDraft({
      name: asset.name,
      category: asset.category,
      status: asset.status,
      location: asset.location,
      serialNumber: asset.serialNumber,
      notes: asset.notes,
    });
  };
  const save = () => {
    if (
      !isEquipmentCategory(draft.category) ||
      !isEquipmentStatus(draft.status)
    ) {
      setError(
        "Choose a supported category and status before saving this legacy asset.",
      );
      return;
    }
    mutation.mutate({
      kind: "save",
      id: editing === "new" || editing === null ? undefined : editing.id,
      expectedRevision:
        editing === "new" || editing === null ? undefined : editing.revision,
      value: {
        orgId,
        ...draft,
        category: draft.category as EquipmentCategory,
        status: draft.status as EquipmentStatus,
      },
    });
  };

  return (
    <Page
      backTo="/(app)/operations"
      backLabel="Back to operations"
      eyebrow="PRODUCTION LIBRARY"
      title="Assets"
      refreshing={query.isRefetching}
      onRefresh={() => void query.refetch()}
      action={
        query.data?.canManage ? (
          <View style={styles.headerAction}>
            <AppButton
              label="Add"
              onPress={() => {
                setEditing("new");
                setDraft(emptyAsset);
              }}
            />
          </View>
        ) : undefined
      }
    >
      {query.error ? <OperationsError message={query.error.message} /> : null}
      {error ? <OperationsError message={error} /> : null}
      <AppField
        label="Search inventory"
        value={search}
        onChangeText={setSearch}
        placeholder="Name, category, location, or serial"
      />
      {editing ? (
        <OperationsPanel
          title={editing === "new" ? "Add asset" : `Edit ${editing.name}`}
          detail="Status changes flow into the technical-manager readiness dashboard."
        >
          <AppField
            label="Name"
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
          />
          <ChoiceField
            label="Category"
            options={EQUIPMENT_CATEGORIES}
            value={draft.category}
            labelFor={equipmentCategoryLabel}
            onChange={(category) => setDraft({ ...draft, category })}
          />
          <ChoiceField
            label="Status"
            options={EQUIPMENT_STATUSES}
            value={draft.status}
            labelFor={equipmentStatusLabel}
            onChange={(status) => setDraft({ ...draft, status })}
          />
          <AppField
            label="Location"
            value={draft.location}
            onChangeText={(location) => setDraft({ ...draft, location })}
          />
          <AppField
            label="Serial number"
            value={draft.serialNumber}
            onChangeText={(serialNumber) =>
              setDraft({ ...draft, serialNumber })
            }
          />
          <AppField
            label="Notes"
            value={draft.notes}
            onChangeText={(notes) => setDraft({ ...draft, notes })}
            multiline
            style={styles.notes}
          />
          <View style={styles.buttonRow}>
            <View style={styles.flex}>
              <AppButton
                label="Cancel"
                variant="secondary"
                onPress={() => setEditing(null)}
              />
            </View>
            <View style={styles.flex}>
              <AppButton
                label="Save asset"
                loading={mutation.isPending}
                disabled={!draft.name.trim()}
                onPress={save}
              />
            </View>
          </View>
          {editing !== "new" ? (
            <AppButton
              label="Delete asset"
              variant="danger"
              disabled={mutation.isPending}
              onPress={() =>
                Alert.alert(
                  "Delete asset?",
                  `Permanently remove “${editing.name}” from the shared inventory?`,
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () =>
                        mutation.mutate({
                          kind: "remove",
                          id: editing.id,
                          expectedRevision: editing.revision,
                        }),
                    },
                  ],
                )
              }
            />
          ) : null}
        </OperationsPanel>
      ) : null}
      <OperationsPanel
        title="Inventory"
        detail={`${filtered.length} of ${query.data?.assets.length ?? 0} assets`}
      >
        {filtered.length ? (
          filtered.map((asset) => (
            <OperationsRow
              key={asset.id}
              title={asset.name}
              detail={[asset.category, asset.location, asset.serialNumber]
                .filter(Boolean)
                .join(" · ")}
              status={asset.status}
              onPress={
                query.data?.canManage ? () => beginEdit(asset) : undefined
              }
            />
          ))
        ) : (
          <OperationsEmpty>No assets match this view.</OperationsEmpty>
        )}
      </OperationsPanel>
    </Page>
  );
}

function ChoiceField({
  label,
  options,
  value,
  labelFor,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string;
  labelFor: (value: string) => string;
  onChange: (value: string) => void;
}) {
  const styles = useStyles();
  const renderedOptions = options.includes(value)
    ? options
    : [value, ...options];
  return (
    <View style={styles.choiceField}>
      <Text style={styles.choiceLabel}>{label}</Text>
      <View accessibilityRole="radiogroup" style={styles.choices}>
        {renderedOptions.map((option) => {
          const selected = option === value;
          const unknown = !options.includes(option);
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              key={option}
              onPress={() => onChange(option)}
              style={[
                styles.choice,
                selected && styles.choiceActive,
                unknown && styles.choiceUnknown,
              ]}
            >
              <Text
                style={[styles.choiceText, selected && styles.choiceTextActive]}
              >
                {labelFor(option)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    headerAction: { width: 88 },
    notes: { minHeight: 88, paddingTop: 13, textAlignVertical: "top" },
    buttonRow: { flexDirection: "row", gap: 8 },
    flex: { flex: 1 },
    choiceField: { gap: 8 },
    choiceLabel: {
      color: colors.textMuted,
      fontFamily,
      fontSize: 13,
      fontWeight: "600",
    },
    choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
    choice: {
      minHeight: 42,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.panelStrong,
      paddingHorizontal: 11,
    },
    choiceActive: {
      borderColor: colors.amber,
      backgroundColor: colors.amberSoft,
    },
    choiceUnknown: { borderColor: colors.red },
    choiceText: {
      color: colors.textMuted,
      fontFamily,
      fontSize: 11,
      fontWeight: "800",
    },
    choiceTextActive: { color: colors.amberText },
  }),
);
