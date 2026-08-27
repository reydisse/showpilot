import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import CircleDot from "lucide-react-native/icons/circle-dot";
import Plus from "lucide-react-native/icons/plus";
import UserRound from "lucide-react-native/icons/user-round";
import { Redirect } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { authClient } from "@/lib/auth-client";
import { getMobileIncidents, reportMobileIncident } from "@/lib/mobile-api";
import { getServiceDateForTimeZone } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const categories = ["audio", "video", "stream", "lighting", "other"] as const;
const severities = ["low", "medium", "high"] as const;

export default function IncidentsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: bootstrap } = useMobileBootstrap();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [category, setCategory] = useState<(typeof categories)[number]>("audio");
  const [severity, setSeverity] = useState<(typeof severities)[number]>("medium");
  const [description, setDescription] = useState("");
  const reportServiceDate = bootstrap?.timeZone
    ? getServiceDateForTimeZone(bootstrap.timeZone)
    : null;
  const query = useQuery({ queryKey: ["mobile-incidents", organization?.id], queryFn: () => getMobileIncidents(organization!.id), enabled: Boolean(organization?.id), refetchInterval: 20_000 });
  const mutation = useMutation({
    mutationFn: () => {
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
      await queryClient.invalidateQueries({ queryKey: ["mobile-incidents", organization?.id] });
    },
    onError: (error) => Alert.alert("Incident not reported", error.message),
  });
  if (organizationPending) return <LoadingView label="Opening incidents…" />;
  if (!organization) return <Redirect href="/organizations" />;
  const openCount = query.data?.incidents.filter((incident) => incident.status === "open").length ?? 0;

  return (
    <Page eyebrow="OPERATIONS LOG" title="Incidents" scroll={false} action={query.data?.canReport ? <Pressable accessibilityRole="button" accessibilityLabel="Report incident" onPress={() => setReporting((value) => !value)} style={styles.addButton}><Plus color={colors.black} size={20} /></Pressable> : null}>
      <FlatList
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.list}
        data={query.data?.incidents ?? []}
        initialNumToRender={10}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(incident) => incident.id}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            <View style={styles.summary}><AlertTriangle color={openCount ? colors.red : colors.green} size={20} /><Text style={styles.summaryValue}>{openCount}</Text><Text style={styles.summaryText}>open {openCount === 1 ? "incident" : "incidents"}</Text></View>
            {reporting ? (
              <View style={styles.form}>
                <Text style={styles.formTitle}>Report what happened</Text>
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
                <AppButton label={mutation.isPending ? "Reporting…" : "Report incident"} disabled={mutation.isPending || !reportServiceDate || description.trim().length < 2} onPress={() => mutation.mutate()} />
              </View>
            ) : null}
            {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
            {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? <Text style={styles.empty}>No incidents have been reported.</Text> : null}
        maxToRenderPerBatch={10}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: incident }) => {
          const open = incident.status === "open";
          return <View style={[styles.card, open && incident.severity === "high" && styles.cardHigh]}><View style={styles.cardHeader}>{open ? <CircleDot color={incident.severity === "high" ? colors.red : colors.amber} size={16} /> : <CheckCircle2 color={colors.green} size={16} />}<Text style={styles.category}>{incident.category}</Text><Text style={[styles.severity, incident.severity === "high" && styles.severityHigh]}>{incident.severity}</Text><Text style={styles.date}>{incident.serviceDate}</Text></View><Text style={styles.description}>{incident.description}</Text><View style={styles.owner}><UserRound color={colors.textFaint} size={13} /><Text style={styles.ownerText}>{incident.assignedName || `Reported by ${incident.reportedBy}`}</Text><Text style={styles.status}>{incident.status}</Text></View></View>;
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
  formTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "800" },
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
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
}));
