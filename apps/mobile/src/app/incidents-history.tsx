import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Search from "lucide-react-native/icons/search";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import X from "lucide-react-native/icons/x";
import { Redirect } from "expo-router";
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { getMobileIncidentHistory, type MobileIncidentHistoryFilters } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const initialFilters: MobileIncidentHistoryFilters = {
  status: "all",
  severity: "all",
  sort: "newest",
  page: 1,
};

const statuses = ["all", "open", "resolved"] as const;
const severities = ["all", "low", "medium", "high", "critical"] as const;
const sorts = ["newest", "oldest", "severity"] as const;

export default function IncidentHistoryScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draft, setDraft] = useState<MobileIncidentHistoryFilters>(initialFilters);
  const [applied, setApplied] = useState<MobileIncidentHistoryFilters>(initialFilters);
  const query = useQuery({
    queryKey: ["mobile-incident-history", organization?.id, applied],
    queryFn: () => getMobileIncidentHistory(organization!.id, applied),
    enabled: Boolean(organization?.id),
  });

  if (organizationPending) return <LoadingView label="Opening incident history…" />;
  if (!organization) return <Redirect href="/organizations" />;

  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / (query.data?.pageSize ?? 30)));
  const appliedFilterCount = [applied.query, applied.category, applied.assignee, applied.from, applied.to]
    .filter(Boolean).length
    + (applied.status === "all" ? 0 : 1)
    + (applied.severity === "all" ? 0 : 1)
    + (applied.sort === "newest" ? 0 : 1);

  function applyFilters() {
    setApplied({ ...draft, page: 1 });
    setFiltersOpen(false);
  }

  function setPage(page: number) {
    setApplied((current) => ({ ...current, page }));
    setDraft((current) => ({ ...current, page }));
  }

  return (
    <Page
      action={(
        <Pressable accessibilityLabel="Filter incident history" accessibilityRole="button" onPress={() => setFiltersOpen(true)} style={styles.filterButton}>
          <SlidersHorizontal color={colors.black} size={18} />
          {appliedFilterCount ? <View style={styles.filterBadge}><Text style={styles.filterBadgeText}>{appliedFilterCount}</Text></View> : null}
        </Pressable>
      )}
      eyebrow="OPERATIONS LOG"
      scroll={false}
      title="Incident history"
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={query.data?.incidents ?? []}
        keyExtractor={(incident) => incident.id}
        ListHeaderComponent={(
          <View style={styles.header}>
            <View style={styles.resultSummary}>
              <Text style={styles.resultValue}>{query.data?.total ?? 0}</Text>
              <Text style={styles.resultText}>matching incidents</Text>
            </View>
            {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
            {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? <Text style={styles.empty}>No incidents match these filters.</Text> : null}
        ListFooterComponent={query.data && query.data.total > 0 ? (
          <View style={styles.pagination}>
            <Pressable accessibilityLabel="Previous history page" accessibilityRole="button" disabled={applied.page <= 1} onPress={() => setPage(applied.page - 1)} style={styles.pageButton}><ChevronLeft color={colors.text} size={18} /></Pressable>
            <Text style={styles.pageText}>Page {applied.page} of {totalPages}</Text>
            <Pressable accessibilityLabel="Next history page" accessibilityRole="button" disabled={applied.page >= totalPages} onPress={() => setPage(applied.page + 1)} style={styles.pageButton}><ChevronRight color={colors.text} size={18} /></Pressable>
          </View>
        ) : null}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: incident }) => (
          <View style={[styles.card, incident.severity === "high" || incident.severity === "critical" ? styles.cardHigh : null]}>
            <View style={styles.cardHeader}>
              {incident.status === "resolved" ? <CheckCircle2 color={colors.green} size={16} /> : <AlertTriangle color={colors.red} size={16} />}
              <Text style={styles.category}>{incident.category}</Text>
              <Text style={styles.severity}>{incident.severity}</Text>
              <Text style={styles.date}>{incident.serviceDate}</Text>
            </View>
            <Text style={styles.description}>{incident.description}</Text>
            <Text style={styles.meta}>Reported by {incident.reportedBy}{incident.assignedName ? ` · Assigned to ${incident.assignedName}` : ""}</Text>
            <Text style={styles.meta}>{incident.status}{incident.commentCount ? ` · ${incident.commentCount} ${incident.commentCount === 1 ? "comment" : "comments"}` : ""}</Text>
          </View>
        )}
      />
      <Modal animationType="slide" onRequestClose={() => setFiltersOpen(false)} transparent visible={filtersOpen}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeading}><Text style={styles.modalTitle}>Filter history</Text><Text style={styles.modalSubtitle}>Search all incident records, not only the recent list.</Text></View>
              <Pressable accessibilityLabel="Close history filters" onPress={() => setFiltersOpen(false)} style={styles.iconButton}><X color={colors.textMuted} size={19} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>SEARCH</Text>
              <View style={styles.searchBox}><Search color={colors.textFaint} size={16} /><TextInput accessibilityLabel="Search incident history" maxLength={200} onChangeText={(value) => setDraft((current) => ({ ...current, query: value }))} placeholder="Description, reporter, owner, category" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={draft.query ?? ""} /></View>
              <ChoiceField label="STATUS" options={statuses} value={draft.status} onChange={(status) => setDraft((current) => ({ ...current, status }))} />
              <ChoiceField label="SEVERITY" options={severities} value={draft.severity} onChange={(severity) => setDraft((current) => ({ ...current, severity }))} />
              <ChoiceField label="SORT" options={sorts} value={draft.sort} onChange={(sort) => setDraft((current) => ({ ...current, sort }))} />
              <Text style={styles.label}>CATEGORY</Text>
              <View style={styles.choices}>
                <Pressable accessibilityRole="radio" accessibilityState={{ checked: !draft.category }} onPress={() => setDraft((current) => ({ ...current, category: undefined }))} style={[styles.choice, !draft.category && styles.choiceActive]}><Text style={[styles.choiceText, !draft.category && styles.choiceTextActive]}>all</Text></Pressable>
                {(query.data?.categories ?? []).map((category) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: draft.category === category }} key={category} onPress={() => setDraft((current) => ({ ...current, category }))} style={[styles.choice, draft.category === category && styles.choiceActive]}><Text style={[styles.choiceText, draft.category === category && styles.choiceTextActive]}>{category}</Text></Pressable>)}
              </View>
              <Text style={styles.label}>ASSIGNEE</Text>
              <TextInput accessibilityLabel="Filter by assignee" maxLength={200} onChangeText={(value) => setDraft((current) => ({ ...current, assignee: value }))} placeholder="Name contains…" placeholderTextColor={colors.textFaint} style={styles.input} value={draft.assignee ?? ""} />
              <View style={styles.dateFields}>
                <View style={styles.dateField}><Text style={styles.label}>FROM DATE</Text><TextInput accessibilityLabel="History from date" autoCapitalize="none" maxLength={10} onChangeText={(value) => setDraft((current) => ({ ...current, from: value }))} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textFaint} style={styles.input} value={draft.from ?? ""} /></View>
                <View style={styles.dateField}><Text style={styles.label}>TO DATE</Text><TextInput accessibilityLabel="History to date" autoCapitalize="none" maxLength={10} onChangeText={(value) => setDraft((current) => ({ ...current, to: value }))} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textFaint} style={styles.input} value={draft.to ?? ""} /></View>
              </View>
              <View style={styles.formActions}>
                <AppButton label="Reset" variant="secondary" onPress={() => setDraft(initialFilters)} />
                <View style={styles.applyButton}><AppButton label="Apply filters" onPress={applyFilters} /></View>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Page>
  );
}

function ChoiceField<T extends string>({ label, options, value, onChange }: { label: string; options: readonly T[]; value: T; onChange: (value: T) => void }) {
  const styles = useStyles();
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><View accessibilityRole="radiogroup" style={styles.choices}>{options.map((option) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: option === value }} key={option} onPress={() => onChange(option)} style={[styles.choice, option === value && styles.choiceActive]}><Text style={[styles.choiceText, option === value && styles.choiceTextActive]}>{option}</Text></Pressable>)}</View></View>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  filterButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amber },
  filterBadge: { position: "absolute", right: -3, top: -3, minWidth: 18, height: 18, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.red },
  filterBadgeText: { color: colors.white, fontFamily, fontSize: 9, fontWeight: "900" },
  list: { gap: 10, paddingBottom: spacing.large },
  header: { gap: spacing.medium, marginBottom: 4 },
  resultSummary: { flexDirection: "row", alignItems: "baseline", gap: 7 },
  resultValue: { color: colors.text, fontFamily, fontSize: 23, fontWeight: "900" },
  resultText: { color: colors.textMuted, fontFamily, fontSize: 12 },
  card: { gap: 8, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.medium },
  cardHigh: { borderColor: colors.redBorder },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 7 },
  category: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  severity: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.amberSoft, color: colors.amberText, fontFamily, fontSize: 8, fontWeight: "900", textTransform: "uppercase", paddingHorizontal: 7, paddingVertical: 3 },
  date: { marginLeft: "auto", color: colors.textFaint, fontFamily, fontSize: 9 },
  description: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 20 },
  meta: { color: colors.textMuted, fontFamily, fontSize: 9, lineHeight: 14, textTransform: "capitalize" },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, textAlign: "center", paddingVertical: spacing.large },
  pagination: { minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 15, marginTop: spacing.small },
  pageButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  pageText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay, paddingTop: spacing.xlarge },
  modalCard: { maxHeight: "92%", gap: spacing.medium, borderTopLeftRadius: radii.large, borderTopRightRadius: radii.large, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.medium, paddingBottom: spacing.xlarge },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  modalHeading: { flex: 1, gap: 4 },
  modalTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.panel },
  form: { gap: spacing.medium, paddingBottom: spacing.small },
  field: { gap: 8 },
  label: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { minHeight: 42, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 8 },
  choiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  choiceText: { color: colors.textMuted, fontFamily, fontSize: 9, fontWeight: "800", textTransform: "uppercase" },
  choiceTextActive: { color: colors.amberText },
  searchBox: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 11 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 12 },
  input: { minHeight: 48, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 12, paddingHorizontal: 11 },
  dateFields: { flexDirection: "row", gap: 9 },
  dateField: { flex: 1, gap: 8 },
  formActions: { flexDirection: "row", alignItems: "center", gap: 9 },
  applyButton: { flex: 1 },
}));
