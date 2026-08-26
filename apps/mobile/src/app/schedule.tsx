import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, MapPin, Users } from "lucide-react-native";
import { Redirect } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { getMobileSchedule, respondToMobileAssignment, type MobileSchedule } from "@/lib/mobile-api";
import { formatServiceTime } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function ScheduleScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: organization } = authClient.useActiveOrganization();
  const queryClient = useQueryClient();
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const query = useQuery({
    queryKey: ["mobile-schedule", organization?.id],
    queryFn: () => getMobileSchedule(organization!.id),
    enabled: Boolean(organization?.id),
    refetchInterval: 30_000,
  });
  const responseMutation = useMutation({
    mutationFn: (input: { assignmentId: string; response: "confirmed" | "declined"; reason?: string }) => respondToMobileAssignment({ orgId: organization!.id, ...input }),
    onSuccess: async () => {
      setDecliningId(null);
      setReason("");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await queryClient.invalidateQueries({ queryKey: ["mobile-schedule", organization?.id] });
    },
    onError: (error) => Alert.alert("Response not saved", error.message),
  });
  if (!organization) return <Redirect href="/organizations" />;

  function respond(assignmentId: string, response: "confirmed" | "declined") {
    responseMutation.mutate({ assignmentId, response, reason: response === "declined" ? reason.trim() : "" });
  }

  return (
    <Page eyebrow="CREW PLAN" title="Schedule" refreshing={query.isRefetching} onRefresh={query.refetch}>
      {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
      {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
      <View style={styles.list}>
        {query.data?.services.map((service) => {
          const assignments = query.data.assignments.filter((assignment) => assignment.showId === service.id);
          return (
            <View key={service.id} style={styles.card}>
              <View style={styles.dateBlock}><Text style={styles.dateDay}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { day: "2-digit" })}</Text><Text style={styles.dateMonth}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { month: "short" }).toUpperCase()}</Text></View>
              <View style={styles.cardCopy}>
                <Text style={styles.title}>{service.name || "Untitled show"}</Text>
                <View style={styles.meta}><Clock3 size={13} color={colors.textFaint} /><Text style={styles.metaText}>{formatServiceTime(service.scheduledStartTime, query.data.timeZone)}</Text>{service.location ? <><MapPin size={13} color={colors.textFaint} /><Text style={styles.metaText}>{service.location}</Text></> : null}</View>
                <View style={styles.metrics}><Text style={styles.metric}>{service.completedItems}/{service.itemCount} rundown</Text><Text style={styles.metric}>{service.crewConfirmed}/{service.crewTotal} confirmed</Text>{service.crewOpen ? <Text style={styles.warning}>{service.crewOpen} open</Text> : null}</View>
                {assignments.length ? <View style={styles.assignments}>{assignments.map((assignment) => <AssignmentRow key={assignment.id} assignment={assignment} declining={decliningId === assignment.id} reason={reason} pending={responseMutation.isPending} onReason={setReason} onDecline={() => { setReason(""); setDecliningId(assignment.id); }} onCancel={() => { setReason(""); setDecliningId(null); }} onRespond={(response) => respond(assignment.id, response)} />)}</View> : null}
              </View>
            </View>
          );
        })}
      </View>
      {query.data && query.data.services.length === 0 ? <Text style={styles.empty}>No services are scheduled in this range.</Text> : null}
    </Page>
  );
}

function AssignmentRow({ assignment, declining, reason, pending, onReason, onDecline, onCancel, onRespond }: {
  assignment: MobileSchedule["assignments"][number];
  declining: boolean;
  reason: string;
  pending: boolean;
  onReason: (value: string) => void;
  onDecline: () => void;
  onCancel: () => void;
  onRespond: (response: "confirmed" | "declined") => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const responseClosed = assignment.status === "assigned" && assignment.responseWindow.status === "closed";
  const displayStatus = responseClosed ? "closed" : assignment.status;
  return (
    <View style={styles.assignmentBlock}>
      <View style={styles.assignment}>
        <Users size={12} color={colors.textFaint} />
        <View style={styles.assignmentCopy}>
          <Text style={styles.assignmentRole}>{assignment.role}</Text>
          <Text style={styles.assignmentText}>{assignment.crewName || "Open position"}{assignment.callTime ? ` · Call ${assignment.callTime}` : ""}</Text>
        </View>
        <Text style={[styles.status, assignment.status === "confirmed" && styles.confirmed, (assignment.status === "declined" || responseClosed) && styles.declined]}>{displayStatus}</Text>
      </View>
      {assignment.responseNote ? <Text style={styles.responseNote}>{assignment.responseNote}</Text> : null}
      {responseClosed ? <Text style={styles.closedNote}>The response window closed when this service ended.</Text> : null}
      {assignment.canRespond && assignment.status === "assigned" && !declining ? (
        <View style={styles.responseActions}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Accept ${assignment.role} assignment`} accessibilityState={{ busy: pending, disabled: pending }} disabled={pending} onPress={() => onRespond("confirmed")} style={({ pressed }) => [styles.responseButton, styles.confirmButton, pressed && styles.pressed]}><Text style={styles.confirmText}>Accept</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Decline ${assignment.role} assignment`} accessibilityState={{ busy: pending, disabled: pending }} disabled={pending} onPress={onDecline} style={({ pressed }) => [styles.responseButton, styles.declineButton, pressed && styles.pressed]}><Text style={styles.declineText}>Decline</Text></Pressable>
        </View>
      ) : null}
      {declining ? (
        <View style={styles.declineForm}>
          <TextInput accessibilityLabel={`Reason for declining ${assignment.role}`} multiline maxLength={500} value={reason} onChangeText={onReason} placeholder="Tell the team why you cannot serve (optional)" placeholderTextColor={colors.textFaint} style={styles.reasonInput} />
          <View style={styles.responseActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel decline" accessibilityState={{ disabled: pending }} disabled={pending} onPress={onCancel} style={({ pressed }) => [styles.responseButton, styles.cancelButton, pressed && styles.pressed]}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Confirm declining ${assignment.role} assignment`} accessibilityState={{ busy: pending, disabled: pending }} disabled={pending} onPress={() => onRespond("declined")} style={({ pressed }) => [styles.responseButton, styles.declineButton, pressed && styles.pressed]}><Text style={styles.declineText}>{pending ? "Saving…" : "Confirm decline"}</Text></Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 12 },
  card: { flexDirection: "row", gap: 13, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  dateBlock: { width: 48, height: 52, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amberSoft },
  dateDay: { color: colors.amberText, fontFamily, fontSize: 20, fontWeight: "900" },
  dateMonth: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  cardCopy: { flex: 1, minWidth: 0, gap: 8 },
  title: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  metaText: { color: colors.textMuted, fontFamily, fontSize: 11, marginRight: 6 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  metric: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.panelStrong, color: colors.textMuted, fontFamily, fontSize: 9, fontWeight: "700", paddingHorizontal: 7, paddingVertical: 4 },
  warning: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.amberSoft, color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800", paddingHorizontal: 7, paddingVertical: 4 },
  assignments: { gap: 6, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  assignmentBlock: { gap: 7, borderRadius: radii.small, backgroundColor: colors.panel, padding: 9 },
  assignment: { flexDirection: "row", alignItems: "center", gap: 7 },
  assignmentCopy: { flex: 1, minWidth: 0, gap: 2 },
  assignmentRole: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "800" },
  assignmentText: { color: colors.textMuted, fontFamily, fontSize: 10 },
  status: { color: colors.textFaint, fontFamily, fontSize: 8, fontWeight: "900", textTransform: "uppercase" },
  confirmed: { color: colors.green },
  declined: { color: colors.red },
  responseNote: { color: colors.textMuted, fontFamily, fontSize: 10, lineHeight: 16, overflow: "hidden", borderRadius: radii.small, backgroundColor: colors.redSoft, padding: 8 },
  closedNote: { color: colors.red, fontFamily, fontSize: 10, lineHeight: 16 },
  responseActions: { flexDirection: "row", justifyContent: "flex-end", gap: 7 },
  responseButton: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, paddingHorizontal: 13 },
  confirmButton: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  confirmText: { color: colors.green, fontFamily, fontSize: 10, fontWeight: "900" },
  declineButton: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  declineText: { color: colors.red, fontFamily, fontSize: 10, fontWeight: "900" },
  cancelButton: { borderColor: colors.border, backgroundColor: colors.panelStrong },
  cancelText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "900" },
  declineForm: { gap: 8 },
  reasonInput: { minHeight: 76, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 12, lineHeight: 18, padding: 10, textAlignVertical: "top" },
  pressed: { opacity: 0.72 },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
}));
