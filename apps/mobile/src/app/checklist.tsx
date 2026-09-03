import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Circle from "lucide-react-native/icons/circle";
import ListChecks from "lucide-react-native/icons/list-checks";
import Sparkles from "lucide-react-native/icons/sparkles";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import { Redirect, useLocalSearchParams } from "expo-router";
import * as Haptics from "@/lib/haptics";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { authClient } from "@/lib/auth-client";
import {
  addMobileChecklistItem,
  applyMobileChecklistDraft,
  getMobileChecklist,
  getMobileChecklistDraft,
  removeMobileChecklistEntry,
  toggleMobileChecklistEntry,
  updateMobileChecklistCategory,
  type ChecklistDepartment,
  type MobileChecklist,
  type MobileChecklistEntry,
  type MobileChecklistSuggestion,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const departmentOrder = ["audio", "video", "lighting", "stream", "general"] as const;
const departmentLabels: Record<ChecklistDepartment, string> = {
  audio: "Audio",
  video: "Video",
  lighting: "Lighting",
  stream: "Stream",
  general: "General",
};

type ChecklistRow =
  | { kind: "heading"; department: ChecklistDepartment; complete: number; total: number }
  | { kind: "entry"; entry: MobileChecklistEntry };

function formatShowDate(serviceDate: string) {
  const parsed = new Date(`${serviceDate}T12:00:00`);
  return parsed.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShowLabel(show: MobileChecklist["show"]) {
  const title = show.name.trim() || "Untitled show";
  const time = show.scheduledStartTime?.trim();
  return `${formatShowDate(show.serviceDate)} · ${time ? `${time} · ` : ""}${title}`;
}

function completedAtLabel(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function ChecklistScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ showId?: string | string[] }>();
  const requestedShowId = Array.isArray(params.showId) ? params.showId[0] : params.showId;
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: bootstrap, isPending: bootstrapPending } = useMobileBootstrap();
  const queryClient = useQueryClient();
  const [selectedShowId, setSelectedShowId] = useState(requestedShowId ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newCategory, setNewCategory] = useState<ChecklistDepartment>("general");
  const [categoryEntry, setCategoryEntry] = useState<MobileChecklistEntry | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedShowId && bootstrap?.shows[0]?.id) setSelectedShowId(bootstrap.shows[0].id);
  }, [bootstrap?.shows, selectedShowId]);

  const queryKey = ["mobile-checklist", organization?.id, selectedShowId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => getMobileChecklist(organization!.id, selectedShowId),
    enabled: Boolean(organization?.id && selectedShowId),
    refetchInterval: 20_000,
  });
  const draftQuery = useQuery({
    queryKey: ["mobile-checklist-draft", organization?.id, selectedShowId],
    queryFn: () => getMobileChecklistDraft(organization!.id, selectedShowId),
    enabled: Boolean(draftOpen && organization?.id && selectedShowId),
  });

  useEffect(() => {
    if (!draftQuery.data) return;
    setSelectedSuggestionIds(new Set(draftQuery.data.suggestions.map((suggestion) => suggestion.id)));
  }, [draftQuery.data]);

  async function refreshChecklist() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mobile-checklist", organization?.id] }),
      queryClient.invalidateQueries({ queryKey: ["mobile-checklist-draft", organization?.id, selectedShowId] }),
    ]);
  }

  const addMutation = useMutation({
    mutationFn: () => addMobileChecklistItem({
      orgId: organization!.id,
      showId: selectedShowId,
      label: newLabel.trim(),
      category: newCategory,
    }),
    onSuccess: async () => {
      setNewLabel("");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refreshChecklist();
    },
    onError: (error) => Alert.alert("Item not added", error.message),
  });
  const toggleMutation = useMutation({
    mutationFn: (input: { entryId: string; checked: boolean }) => toggleMobileChecklistEntry({
      orgId: organization!.id,
      ...input,
    }),
    onMutate: async ({ entryId, checked }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<MobileChecklist>(queryKey);
      queryClient.setQueryData<MobileChecklist>(queryKey, (current) => current ? {
        ...current,
        entries: current.entries.map((entry) => entry.id === entryId ? {
          ...entry,
          checked,
          checkedBy: checked ? bootstrap?.identity.name ?? null : null,
          checkedAt: checked ? new Date().toISOString() : null,
        } : entry),
      } : current);
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      Alert.alert("Checklist not updated", error.message);
    },
    onSuccess: () => Haptics.selectionAsync(),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
  const removeMutation = useMutation({
    mutationFn: (entryId: string) => removeMobileChecklistEntry({ orgId: organization!.id, entryId }),
    onSuccess: refreshChecklist,
    onError: (error) => Alert.alert("Item not removed", error.message),
  });
  const categoryMutation = useMutation({
    mutationFn: (input: { templateId: string; category: ChecklistDepartment }) =>
      updateMobileChecklistCategory({ orgId: organization!.id, ...input }),
    onSuccess: async () => {
      setCategoryEntry(null);
      await refreshChecklist();
    },
    onError: (error) => Alert.alert("Department not changed", error.message),
  });
  const applyMutation = useMutation({
    mutationFn: () => applyMobileChecklistDraft({
      orgId: organization!.id,
      showId: selectedShowId,
      suggestionIds: Array.from(selectedSuggestionIds),
    }),
    onSuccess: async ({ added }) => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDraftOpen(false);
      await refreshChecklist();
      if (added === 0) Alert.alert("Checklist already current", "No new checks needed to be added.");
    },
    onError: (error) => Alert.alert("Checks not added", error.message),
  });

  const entries = useMemo(() => query.data?.entries ?? [], [query.data?.entries]);
  const rows = useMemo<ChecklistRow[]>(() => {
    const groups = departmentOrder.map((department) => ({
      department,
      entries: entries.filter((entry) => entry.category === department),
    })).filter((group) => group.entries.length > 0);
    return groups.flatMap((group) => [
      ...(groups.length > 1 ? [{
        kind: "heading" as const,
        department: group.department,
        complete: group.entries.filter((entry) => entry.checked).length,
        total: group.entries.length,
      }] : []),
      ...group.entries.map((entry) => ({ kind: "entry" as const, entry })),
    ]);
  }, [entries]);
  const completeCount = entries.filter((entry) => entry.checked).length;
  const progress = entries.length ? Math.round((completeCount / entries.length) * 100) : 0;
  const shows = query.data?.shows ?? bootstrap?.shows ?? [];
  const selectedIndex = shows.findIndex((show) => show.id === selectedShowId);

  if (organizationPending || bootstrapPending) return <LoadingView label="Opening checklist…" />;
  if (!organization) return <Redirect href="/organizations" />;

  if (!selectedShowId) {
    return (
      <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="PRE-SHOW" title="Checklist">
        <View style={styles.emptyPanel}>
          <ListChecks color={colors.textFaint} size={30} />
          <Text style={styles.emptyTitle}>No planned show</Text>
          <Text style={styles.emptyText}>Create a show first, then its checklist will be available here.</Text>
        </View>
      </Page>
    );
  }

  const canManage = query.data?.canManage === true;
  const show = query.data?.show;

  function selectShow(showId: string) {
    setPickerOpen(false);
    setSelectedShowId(showId);
  }

  function confirmRemove(entry: MobileChecklistEntry) {
    Alert.alert(
      "Remove checklist item?",
      "This removes it only from the selected service. The reusable template remains available to other services.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeMutation.mutate(entry.id) },
      ],
    );
  }

  return (
    <Page
      backTo="/(app)/operations"
      backLabel="Back to operations"
      eyebrow="PRE-SHOW"
      title="Checklist"
      scroll={false}
      action={canManage ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Generate checklist from rundown" onPress={() => setDraftOpen(true)} style={({ pressed }) => [styles.smartButton, pressed && styles.pressed]}>
          <Sparkles color={colors.amberText} size={17} />
          <Text style={styles.smartButtonText}>Smart</Text>
        </Pressable>
      ) : null}
    >
      <FlatList
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.list}
        data={rows}
        initialNumToRender={16}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(row) => row.kind === "heading" ? `heading-${row.department}` : row.entry.id}
        ListHeaderComponent={(
          <View style={styles.headerContent}>
            <View style={styles.showNavigation}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Previous show"
                disabled={selectedIndex <= 0}
                onPress={() => selectShow(shows[selectedIndex - 1].id)}
                style={({ pressed }) => [styles.arrowButton, selectedIndex <= 0 && styles.disabled, pressed && styles.pressed]}
              >
                <ChevronLeft color={colors.text} size={20} />
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Choose show" onPress={() => setPickerOpen(true)} style={({ pressed }) => [styles.showPicker, pressed && styles.pressed]}>
                <Text numberOfLines={1} style={styles.showPickerText}>{show ? formatShowLabel(show) : "Loading show…"}</Text>
                <Text style={styles.showPickerHint}>CHOOSE SHOW</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Next show"
                disabled={selectedIndex < 0 || selectedIndex >= shows.length - 1}
                onPress={() => selectShow(shows[selectedIndex + 1].id)}
                style={({ pressed }) => [styles.arrowButton, (selectedIndex < 0 || selectedIndex >= shows.length - 1) && styles.disabled, pressed && styles.pressed]}
              >
                <ChevronRight color={colors.text} size={20} />
              </Pressable>
            </View>

            {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
            {query.error ? <Text accessibilityRole="button" onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}

            {entries.length > 0 ? (
              <View style={styles.progressCard}>
                <View style={styles.progressLabels}>
                  <Text style={styles.progressCopy}>{completeCount} of {entries.length} complete</Text>
                  <Text style={styles.progressValue}>{progress}%</Text>
                </View>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]} /></View>
              </View>
            ) : null}

            {canManage ? (
              <View style={styles.addCard}>
                <Text style={styles.sectionLabel}>ADD A CHECK</Text>
                <TextInput
                  accessibilityLabel="New checklist item"
                  maxLength={200}
                  onChangeText={setNewLabel}
                  onSubmitEditing={() => {
                    if (newLabel.trim() && !addMutation.isPending) addMutation.mutate();
                  }}
                  placeholder="Camera check, line check, stream key…"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="done"
                  style={styles.input}
                  value={newLabel}
                />
                <View accessibilityRole="radiogroup" style={styles.choices}>
                  {departmentOrder.map((department) => (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityLabel={`${departmentLabels[department]} department`}
                      accessibilityState={{ checked: newCategory === department }}
                      key={department}
                      onPress={() => setNewCategory(department)}
                      style={[styles.choice, newCategory === department && styles.choiceActive]}
                    >
                      <Text style={[styles.choiceText, newCategory === department && styles.choiceTextActive]}>{departmentLabels[department]}</Text>
                    </Pressable>
                  ))}
                </View>
                <AppButton label={addMutation.isPending ? "Adding…" : "Add checklist item"} disabled={addMutation.isPending || !newLabel.trim()} onPress={() => addMutation.mutate()} />
              </View>
            ) : query.data ? <Text style={styles.viewOnly}>View only · A producer can manage this checklist.</Text> : null}
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? (
          <View style={styles.emptyPanel}>
            <ListChecks color={colors.textFaint} size={30} />
            <Text style={styles.emptyTitle}>No checks for this show</Text>
            <Text style={styles.emptyText}>{canManage ? "Add one above or generate a draft from the rundown." : "A producer has not added any checks yet."}</Text>
          </View>
        ) : null}
        maxToRenderPerBatch={14}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching && !query.isPending}
        renderItem={({ item: row }) => {
          if (row.kind === "heading") return (
            <View style={styles.groupHeading}>
              <Text style={styles.groupTitle}>{departmentLabels[row.department]}</Text>
              <Text style={styles.groupCount}>{row.complete}/{row.total}</Text>
            </View>
          );
          const entry = row.entry;
          const actorTime = completedAtLabel(entry.checkedAt);
          return (
            <View style={[styles.entryCard, entry.checked && styles.entryCardChecked]}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityLabel={`${entry.checked ? "Mark incomplete" : "Mark complete"}: ${entry.label}`}
                accessibilityState={{ checked: entry.checked, disabled: !canManage }}
                disabled={!canManage || (toggleMutation.isPending && toggleMutation.variables?.entryId === entry.id)}
                hitSlop={8}
                onPress={() => toggleMutation.mutate({ entryId: entry.id, checked: !entry.checked })}
                style={({ pressed }) => [styles.checkButton, pressed && styles.pressed]}
              >
                {entry.checked ? <CheckCircle2 color={colors.green} size={23} /> : <Circle color={colors.textFaint} size={23} />}
              </Pressable>
              <View style={styles.entryCopy}>
                <Text style={[styles.entryLabel, entry.checked && styles.entryLabelChecked]}>{entry.label}</Text>
                {entry.checked && entry.checkedBy ? <Text numberOfLines={1} style={styles.entryMeta}>Completed by {entry.checkedBy}{actorTime ? ` · ${actorTime}` : ""}</Text> : null}
              </View>
              {canManage ? (
                <View style={styles.entryActions}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Change department for ${entry.label}`} onPress={() => setCategoryEntry(entry)} style={({ pressed }) => [styles.departmentButton, pressed && styles.pressed]}>
                    <Text style={styles.departmentButtonText}>{departmentLabels[entry.category]}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${entry.label} from this show`} hitSlop={7} onPress={() => confirmRemove(entry)} style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}>
                    <Trash2 color={colors.textFaint} size={17} />
                  </Pressable>
                </View>
              ) : <Text style={styles.departmentReadOnly}>{departmentLabels[entry.category]}</Text>}
            </View>
          );
        }}
        windowSize={7}
      />

      <Modal animationType="slide" onRequestClose={() => setPickerOpen(false)} presentationStyle="pageSheet" visible={pickerOpen}>
        <View style={styles.modalPage}>
          <View style={styles.modalHeader}>
            <View><Text style={styles.modalEyebrow}>SERVICE PICKER</Text><Text style={styles.modalTitle}>Choose a show</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close show picker" onPress={() => setPickerOpen(false)} style={styles.closeButton}><X color={colors.text} size={22} /></Pressable>
          </View>
          <FlatList
            contentContainerStyle={styles.modalList}
            data={shows}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <Pressable accessibilityRole="button" accessibilityLabel={`Select ${formatShowLabel(item)}`} onPress={() => selectShow(item.id)} style={[styles.showOption, item.id === selectedShowId && styles.showOptionActive]}>
                <Text style={styles.showOptionDate}>{formatShowDate(item.serviceDate)}</Text>
                <Text style={styles.showOptionName}>{item.scheduledStartTime ? `${item.scheduledStartTime} · ` : ""}{item.name || "Untitled show"}</Text>
                <Text style={styles.showOptionStatus}>{item.status}</Text>
              </Pressable>
            )}
          />
        </View>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setCategoryEntry(null)} transparent visible={Boolean(categoryEntry)}>
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}><Text style={styles.dialogTitle}>Choose department</Text><Pressable accessibilityRole="button" accessibilityLabel="Close department picker" onPress={() => setCategoryEntry(null)} style={styles.closeButton}><X color={colors.text} size={21} /></Pressable></View>
            <Text numberOfLines={2} style={styles.dialogDescription}>{categoryEntry?.label}</Text>
            <View accessibilityRole="radiogroup" style={styles.departmentList}>
              {departmentOrder.map((department) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityLabel={`${departmentLabels[department]} department`}
                  accessibilityState={{ checked: categoryEntry?.category === department }}
                  disabled={categoryMutation.isPending}
                  key={department}
                  onPress={() => categoryEntry && categoryMutation.mutate({ templateId: categoryEntry.templateId, category: department })}
                  style={[styles.departmentOption, categoryEntry?.category === department && styles.departmentOptionActive]}
                >
                  <Text style={styles.departmentOptionText}>{departmentLabels[department]}</Text>
                  {categoryEntry?.category === department ? <CheckCircle2 color={colors.amberText} size={19} /> : null}
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setDraftOpen(false)} presentationStyle="pageSheet" visible={draftOpen}>
        <View style={styles.modalPage}>
          <View style={styles.modalHeader}>
            <View style={styles.modalHeadingCopy}><Text style={styles.modalEyebrow}>RUNDOWN ANALYSIS</Text><Text style={styles.modalTitle}>Smart checklist draft</Text><Text style={styles.modalSubtitle}>Review every suggestion before adding it.</Text></View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close smart checklist" onPress={() => setDraftOpen(false)} style={styles.closeButton}><X color={colors.text} size={22} /></Pressable>
          </View>
          {draftQuery.isPending ? <View style={styles.modalLoading}><ActivityIndicator color={colors.amber} size="large" /><Text style={styles.emptyText}>Analyzing rundown cues…</Text></View> : null}
          {draftQuery.error ? <Text accessibilityRole="button" onPress={() => draftQuery.refetch()} style={[styles.error, styles.modalError]}>{draftQuery.error.message} · Tap to retry</Text> : null}
          {draftQuery.data ? (
            <FlatList
              contentContainerStyle={styles.draftList}
              data={draftQuery.data.suggestions}
              keyExtractor={(item) => item.id}
              ListHeaderComponent={draftQuery.data.suggestions.length ? (
                <View style={styles.draftToolbar}>
                  <Text style={styles.draftCount}>{selectedSuggestionIds.size} of {draftQuery.data.suggestions.length} selected</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel={selectedSuggestionIds.size === draftQuery.data.suggestions.length ? "Clear all suggestions" : "Select all suggestions"} onPress={() => setSelectedSuggestionIds(selectedSuggestionIds.size === draftQuery.data!.suggestions.length ? new Set() : new Set(draftQuery.data!.suggestions.map((suggestion) => suggestion.id)))}>
                    <Text style={styles.selectAll}>{selectedSuggestionIds.size === draftQuery.data.suggestions.length ? "Clear all" : "Select all"}</Text>
                  </Pressable>
                </View>
              ) : null}
              ListEmptyComponent={<View style={styles.emptyPanel}><ListChecks color={colors.textFaint} size={30} /><Text style={styles.emptyTitle}>No new checks found</Text><Text style={styles.emptyText}>The matching checks may already be on this show.</Text></View>}
              renderItem={({ item }) => <SuggestionCard suggestion={item} selected={selectedSuggestionIds.has(item.id)} onToggle={() => setSelectedSuggestionIds((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />}
            />
          ) : null}
          {draftQuery.data?.suggestions.length ? <View style={styles.modalFooter}><AppButton label={applyMutation.isPending ? "Adding checks…" : `Add ${selectedSuggestionIds.size} checks`} disabled={applyMutation.isPending || selectedSuggestionIds.size === 0} onPress={() => applyMutation.mutate()} /></View> : null}
        </View>
      </Modal>
    </Page>
  );
}

function SuggestionCard({ suggestion, selected, onToggle }: { suggestion: MobileChecklistSuggestion; selected: boolean; onToggle: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityLabel={`${selected ? "Remove" : "Add"} suggestion: ${suggestion.label}`} accessibilityState={{ checked: selected }} onPress={onToggle} style={[styles.suggestion, selected && styles.suggestionSelected]}>
      {selected ? <CheckCircle2 color={colors.amberText} size={21} /> : <Circle color={colors.textFaint} size={21} />}
      <View style={styles.suggestionCopy}>
        <View style={styles.suggestionTitleRow}><Text style={styles.suggestionTitle}>{suggestion.label}</Text><Text style={styles.suggestionDepartment}>{departmentLabels[suggestion.category]}</Text></View>
        <Text style={styles.suggestionReason}>{suggestion.reason}{suggestion.sourceItemIds.length ? ` Matched ${suggestion.sourceItemIds.length} rundown ${suggestion.sourceItemIds.length === 1 ? "item" : "items"}.` : ""}</Text>
        {suggestion.existingTemplateId ? <Text style={styles.existingTemplate}>EXISTING TEMPLATE</Text> : null}
      </View>
    </Pressable>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  smartButton: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 7, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, paddingHorizontal: 13 },
  smartButtonText: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "900" },
  pressed: { opacity: 0.58 },
  disabled: { opacity: 0.25 },
  list: { gap: 9, paddingBottom: spacing.large },
  headerContent: { gap: spacing.large, marginBottom: spacing.small },
  showNavigation: { flexDirection: "row", alignItems: "stretch", gap: 8 },
  arrowButton: { width: 44, minHeight: 58, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  showPicker: { minWidth: 0, flex: 1, justifyContent: "center", gap: 4, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 13, paddingVertical: 9 },
  showPickerText: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  showPickerHint: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.1 },
  progressCard: { gap: 10, borderRadius: radii.medium, backgroundColor: colors.panel, padding: spacing.medium },
  progressLabels: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  progressCopy: { color: colors.textMuted, fontFamily, fontSize: 12 },
  progressValue: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "900" },
  progressTrack: { height: 7, overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.border },
  progressFill: { height: "100%", borderRadius: radii.pill, backgroundColor: colors.amber },
  addCard: { gap: 11, borderRadius: radii.large, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.panel, padding: spacing.medium },
  sectionLabel: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  input: { minHeight: 49, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 14, paddingHorizontal: 13 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { minHeight: 42, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong, paddingHorizontal: 11 },
  choiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  choiceText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  choiceTextActive: { color: colors.amberText },
  groupHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10, paddingHorizontal: 4, paddingVertical: 2 },
  groupTitle: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2, textTransform: "uppercase" },
  groupCount: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "700" },
  entryCard: { minHeight: 67, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 12 },
  entryCardChecked: { backgroundColor: colors.panel },
  checkButton: { width: 34, height: 42, alignItems: "center", justifyContent: "center" },
  entryCopy: { minWidth: 0, flex: 1, gap: 3 },
  entryLabel: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "700", lineHeight: 18 },
  entryLabelChecked: { color: colors.textMuted, textDecorationLine: "line-through" },
  entryMeta: { color: colors.textFaint, fontFamily, fontSize: 11 },
  entryActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  departmentButton: { minHeight: 36, justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
  departmentButtonText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  departmentReadOnly: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800" },
  removeButton: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  viewOnly: { color: colors.textMuted, fontFamily, fontSize: 11, textAlign: "center" },
  emptyPanel: { alignItems: "center", gap: 8, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: spacing.large },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  emptyText: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
  error: { color: colors.red, fontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
  modalPage: { flex: 1, backgroundColor: colors.stage },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, padding: spacing.large },
  modalHeadingCopy: { minWidth: 0, flex: 1, gap: 4 },
  modalEyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.4 },
  modalTitle: { color: colors.text, fontFamily, fontSize: 22, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 12 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  modalList: { gap: 9, padding: spacing.large },
  showOption: { gap: 4, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: spacing.medium },
  showOptionActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  showOptionDate: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  showOptionName: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  showOptionStatus: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  overlay: { flex: 1, justifyContent: "center", backgroundColor: colors.overlay, padding: spacing.large },
  dialog: { width: "100%", maxWidth: 520, alignSelf: "center", gap: spacing.medium, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  dialogHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  dialogTitle: { minWidth: 0, flex: 1, color: colors.text, fontFamily, fontSize: 19, fontWeight: "900" },
  dialogDescription: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  departmentList: { gap: 8 },
  departmentOption: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 14 },
  departmentOptionActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  departmentOptionText: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  modalLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  modalError: { margin: spacing.large },
  draftList: { gap: 9, padding: spacing.large, paddingBottom: spacing.xlarge },
  draftToolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 4 },
  draftCount: { color: colors.textMuted, fontFamily, fontSize: 11 },
  selectAll: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900" },
  suggestion: { flexDirection: "row", alignItems: "flex-start", gap: 11, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 14 },
  suggestionSelected: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  suggestionCopy: { minWidth: 0, flex: 1, gap: 5 },
  suggestionTitleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  suggestionTitle: { minWidth: 0, flex: 1, color: colors.text, fontFamily, fontSize: 13, fontWeight: "800", lineHeight: 18 },
  suggestionDepartment: { overflow: "hidden", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", paddingHorizontal: 7, paddingVertical: 3 },
  suggestionReason: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  existingTemplate: { color: colors.green, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  modalFooter: { borderTopWidth: 1, borderTopColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.large },
}));
