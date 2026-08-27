import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import CircleDot from "lucide-react-native/icons/circle-dot";
import Eye from "lucide-react-native/icons/eye";
import Hand from "lucide-react-native/icons/hand";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import Search from "lucide-react-native/icons/search";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserRound from "lucide-react-native/icons/user-round";
import { Redirect } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { authClient } from "@/lib/auth-client";
import {
  commandMobileIncident,
  getMobileIncidents,
  removeMobileIncident,
  reportMobileIncident,
  updateMobileIncident,
  type MobileIncidents,
} from "@/lib/mobile-api";
import { getServiceDateForTimeZone } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const categories = ["audio", "video", "stream", "lighting", "other"] as const;
const severities = ["low", "medium", "high"] as const;
type IncidentFilter = "open" | "resolved" | "all";
type MobileIncident = MobileIncidents["incidents"][number];

function isIncidentCategory(value: string): value is (typeof categories)[number] {
  return categories.some((category) => category === value);
}

function isIncidentSeverity(value: string): value is (typeof severities)[number] {
  return severities.some((severity) => severity === value);
}

export default function IncidentsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: bootstrap } = useMobileBootstrap();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<IncidentFilter>("open");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<(typeof categories)[number]>("audio");
  const [severity, setSeverity] = useState<(typeof severities)[number]>("medium");
  const [description, setDescription] = useState("");
  const reportServiceDate = bootstrap?.timeZone
    ? getServiceDateForTimeZone(bootstrap.timeZone)
    : null;
  const query = useQuery({ queryKey: ["mobile-incidents", organization?.id], queryFn: () => getMobileIncidents(organization!.id), enabled: Boolean(organization?.id), refetchInterval: 20_000 });
  const mutation = useMutation({
    mutationFn: () => {
      if (editingId) {
        return updateMobileIncident({
          orgId: organization!.id,
          incidentId: editingId,
          category,
          severity,
          description,
        });
      }
      if (!reportServiceDate) throw new Error("ShowPilot is still loading the venue date.");
      return reportMobileIncident({
        orgId: organization!.id,
        category,
        severity,
        description,
        serviceDate: reportServiceDate,
      });
    },
    onSuccess: async () => {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDescription("");
      setReporting(false);
      setEditingId(null);
      await queryClient.invalidateQueries({ queryKey: ["mobile-incidents", organization?.id] });
    },
    onError: (error) => Alert.alert(editingId ? "Incident not saved" : "Incident not reported", error.message),
  });
  const commandMutation = useMutation({
    mutationFn: (input: { incidentId: string; action: "claim" | "acknowledge" | "resolve" }) =>
      commandMobileIncident({ orgId: organization!.id, ...input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mobile-incidents", organization?.id] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Incident not updated", error.message),
  });
  const removeMutation = useMutation({
    mutationFn: (incidentId: string) => removeMobileIncident({ orgId: organization!.id, incidentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mobile-incidents", organization?.id] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Incident not removed", error.message),
  });
  const openCount = query.data?.incidents.filter((incident) => incident.status === "open").length ?? 0;
  const currentUserId = bootstrap?.identity.userId;
  const visibleIncidents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (query.data?.incidents ?? []).filter((incident) => {
      if (filter !== "all" && incident.status !== filter) return false;
      return !needle
        || incident.description.toLowerCase().includes(needle)
        || incident.category.toLowerCase().includes(needle)
        || incident.reportedBy.toLowerCase().includes(needle)
        || incident.assignedName.toLowerCase().includes(needle);
    });
  }, [filter, query.data?.incidents, search]);

  if (organizationPending) return <LoadingView label="Opening incidents…" />;
  if (!organization) return <Redirect href="/organizations" />;

  function startReport() {
    setEditingId(null);
    setCategory("audio");
    setSeverity("medium");
    setDescription("");
    setReporting(true);
  }

  function startEdit(incident: MobileIncident) {
    setEditingId(incident.id);
    setCategory(isIncidentCategory(incident.category) ? incident.category : "other");
    setSeverity(isIncidentSeverity(incident.severity) ? incident.severity : "medium");
    setDescription(incident.description);
    setReporting(true);
  }

  function confirmResolve(incident: MobileIncident) {
    Alert.alert("Resolve incident?", "This moves the incident into history and records you as the resolver.", [
      { text: "Keep open", style: "cancel" },
      { text: "Resolve", onPress: () => commandMutation.mutate({ incidentId: incident.id, action: "resolve" }) },
    ]);
  }

  function confirmRemove(incident: MobileIncident) {
    Alert.alert("Delete incident?", "This permanently removes the incident record.", [
      { text: "Keep incident", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => removeMutation.mutate(incident.id) },
    ]);
  }

  return (
    <Page eyebrow="OPERATIONS LOG" title="Incidents" scroll={false} action={query.data?.canReport ? <Pressable accessibilityRole="button" accessibilityLabel="Report incident" onPress={startReport} style={styles.addButton}><Plus color={colors.black} size={20} /></Pressable> : null}>
      <FlatList
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.list}
        data={visibleIncidents}
        initialNumToRender={10}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(incident) => incident.id}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            <View style={styles.summary}><AlertTriangle color={openCount ? colors.red : colors.green} size={20} /><Text style={styles.summaryValue}>{openCount}</Text><Text style={styles.summaryText}>open {openCount === 1 ? "incident" : "incidents"}</Text></View>
            {reporting ? (
              <View style={styles.form}>
                <View style={styles.formHeader}><Text style={styles.formTitle}>{editingId ? "Edit incident" : "Report what happened"}</Text><Pressable accessibilityLabel="Close incident form" hitSlop={8} onPress={() => { setReporting(false); setEditingId(null); }}><Text style={styles.cancelText}>Cancel</Text></Pressable></View>
                <Text style={styles.label}>CATEGORY</Text>
                <View accessibilityRole="radiogroup" style={styles.choices}>{categories.map((value) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: category === value }} key={value} onPress={() => setCategory(value)} style={[styles.choice, category === value && styles.choiceActive]}><Text style={[styles.choiceText, category === value && styles.choiceTextActive]}>{value}</Text></Pressable>)}</View>
                <Text style={styles.label}>SEVERITY</Text>
                <View accessibilityRole="radiogroup" style={styles.choices}>{severities.map((value) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: severity === value }} key={value} onPress={() => setSeverity(value)} style={[styles.choice, severity === value && styles.choiceActive]}><Text style={[styles.choiceText, severity === value && styles.choiceTextActive]}>{value}</Text></Pressable>)}</View>
                <Text style={styles.label}>DESCRIPTION</Text>
                <TextInput accessibilityLabel="Incident description" multiline maxLength={2000} value={description} onChangeText={setDescription} placeholder="What failed, what is affected, and what has already been tried?" placeholderTextColor={colors.textFaint} style={styles.input} />
                <View style={styles.serviceDateRow}>
                  <Text style={styles.serviceDateLabel}>SERVICE DATE</Text>
                  <Text style={styles.serviceDateValue}>{reportServiceDate ?? "Loading venue date…"}</Text>
                </View>
                <AppButton label={editingId ? "Save changes" : "Report incident"} loading={mutation.isPending} disabled={mutation.isPending || (!editingId && !reportServiceDate) || description.trim().length < 2} onPress={() => mutation.mutate()} />
              </View>
            ) : null}
            <View accessibilityRole="tablist" style={styles.filters}>{(["open", "resolved", "all"] as const).map((value) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: filter === value }} key={value} onPress={() => setFilter(value)} style={[styles.filter, filter === value && styles.filterActive]}><Text style={[styles.filterText, filter === value && styles.filterTextActive]}>{value}</Text></Pressable>)}</View>
            <View style={styles.searchBox}><Search color={colors.textFaint} size={17} /><TextInput accessibilityLabel="Search incident history" onChangeText={setSearch} placeholder="Search incidents, reporters, or owners" placeholderTextColor={colors.textFaint} style={styles.searchInput} value={search} />{search ? <Pressable accessibilityLabel="Clear incident search" onPress={() => setSearch("")}><Text style={styles.cancelText}>Clear</Text></Pressable> : null}</View>
            {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
            {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? <Text style={styles.empty}>{search ? "No incidents match this search." : `No ${filter === "all" ? "" : `${filter} `}incidents.`}</Text> : null}
        maxToRenderPerBatch={10}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: incident }) => {
          const open = incident.status === "open";
          const assignedToMe = incident.assignedTo === currentUserId;
          return <View style={[styles.card, open && incident.severity === "high" && styles.cardHigh]}><View style={styles.cardHeader}>{open ? <CircleDot color={incident.severity === "high" ? colors.red : colors.amber} size={16} /> : <CheckCircle2 color={colors.green} size={16} />}<Text style={styles.category}>{incident.category}</Text><Text style={[styles.severity, incident.severity === "high" && styles.severityHigh]}>{incident.severity}</Text><Text style={styles.date}>{incident.serviceDate}</Text></View><Text style={styles.description}>{incident.description}</Text><View style={styles.owner}><UserRound color={colors.textFaint} size={13} /><Text style={styles.ownerText}>{incident.assignedName || `Reported by ${incident.reportedBy}`}</Text><Text style={styles.status}>{incident.status}</Text></View>{incident.resolvedBy ? <Text style={styles.timeline}>Resolved by {incident.resolvedBy}{incident.resolvedAt ? ` · ${new Date(incident.resolvedAt).toLocaleString()}` : ""}</Text> : incident.acknowledgedAt ? <Text style={styles.timeline}>Acknowledged · {new Date(incident.acknowledgedAt).toLocaleString()}</Text> : incident.assignedName ? <Text style={styles.timeline}>Awaiting acknowledgement</Text> : null}<View style={styles.cardActions}>{query.data?.canManage && open && !incident.assignedTo ? <Pressable accessibilityRole="button" onPress={() => commandMutation.mutate({ incidentId: incident.id, action: "claim" })} style={styles.actionButton}><Hand color={colors.amberText} size={14} /><Text style={styles.actionText}>Claim</Text></Pressable> : null}{query.data?.canManage && open && assignedToMe && !incident.acknowledgedAt ? <Pressable accessibilityRole="button" onPress={() => commandMutation.mutate({ incidentId: incident.id, action: "acknowledge" })} style={styles.actionButton}><Eye color={colors.amberText} size={14} /><Text style={styles.actionText}>Acknowledge</Text></Pressable> : null}{query.data?.canManage && open ? <Pressable accessibilityRole="button" onPress={() => confirmResolve(incident)} style={styles.actionButton}><CheckCircle2 color={colors.green} size={14} /><Text style={styles.actionText}>Resolve</Text></Pressable> : null}{query.data?.canManage ? <Pressable accessibilityLabel={`Edit ${incident.category} incident`} onPress={() => startEdit(incident)} style={styles.iconButton}><Pencil color={colors.textMuted} size={15} /></Pressable> : null}{query.data?.canManage ? <Pressable accessibilityLabel={`Delete ${incident.category} incident`} onPress={() => confirmRemove(incident)} style={styles.iconButton}><Trash2 color={colors.red} size={15} /></Pressable> : null}</View></View>;
        }}
        windowSize={7}
      />
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  addButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amber },
  summary: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryValue: { color: colors.text, fontFamily, fontSize: 22, fontWeight: "900" },
  summaryText: { color: colors.textMuted, fontFamily, fontSize: 13 },
  form: { gap: 11, borderRadius: radii.large, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.panel, padding: spacing.medium },
  formHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  formTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "800" },
  cancelText: { color: colors.amberText, fontFamily, fontSize: 10, fontWeight: "900" },
  label: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1.2 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong, paddingHorizontal: 12, paddingVertical: 8 },
  choiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  choiceText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "800", textTransform: "uppercase" },
  choiceTextActive: { color: colors.amberText },
  input: { minHeight: 112, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 14, lineHeight: 20, padding: 13, textAlignVertical: "top" },
  serviceDateRow: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, borderRadius: radii.small, backgroundColor: colors.panelStrong, paddingHorizontal: 12 },
  serviceDateLabel: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 },
  serviceDateValue: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "700" },
  filters: { flexDirection: "row", gap: 7 },
  filter: { minHeight: 42, flex: 1, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  filterActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  filterText: { color: colors.textMuted, fontFamily, fontSize: 9, fontWeight: "900", textTransform: "uppercase" },
  filterTextActive: { color: colors.amberText },
  searchBox: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 12 },
  list: { gap: 10, paddingBottom: spacing.large },
  listHeader: { gap: spacing.large, marginBottom: 2 },
  card: { gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  cardHigh: { borderColor: colors.redBorder },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 7 },
  category: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  severity: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.amberSoft, color: colors.amberText, fontFamily, fontSize: 8, fontWeight: "900", textTransform: "uppercase", paddingHorizontal: 7, paddingVertical: 3 },
  severityHigh: { backgroundColor: colors.redSoft, color: colors.red },
  date: { marginLeft: "auto", color: colors.textFaint, fontFamily, fontSize: 9 },
  description: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 21 },
  owner: { flexDirection: "row", alignItems: "center", gap: 6 },
  ownerText: { flex: 1, color: colors.textMuted, fontFamily, fontSize: 10 },
  status: { color: colors.textFaint, fontFamily, fontSize: 8, fontWeight: "900", textTransform: "uppercase" },
  timeline: { color: colors.textFaint, fontFamily, fontSize: 9, lineHeight: 14 },
  cardActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 9 },
  actionButton: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 10 },
  actionText: { color: colors.text, fontFamily, fontSize: 9, fontWeight: "900" },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.panel },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
}));
