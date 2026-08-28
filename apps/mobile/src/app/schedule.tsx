import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Bell from "lucide-react-native/icons/bell";
import Boxes from "lucide-react-native/icons/boxes";
import CalendarPlus from "lucide-react-native/icons/calendar-plus";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Clock3 from "lucide-react-native/icons/clock-3";
import Copy from "lucide-react-native/icons/copy";
import ExternalLink from "lucide-react-native/icons/external-link";
import MapPin from "lucide-react-native/icons/map-pin";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import Settings2 from "lucide-react-native/icons/settings-2";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserPlus from "lucide-react-native/icons/user-plus";
import Users from "lucide-react-native/icons/users";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, FlatList, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  ScheduleAssignmentSheet,
  ScheduleInventorySheet,
  ScheduleProviderSheet,
  ScheduleServiceSheet,
  ScheduleTeamSheet,
  type ScheduleAssignmentDraft,
  type ScheduleInventoryDraft,
  type ScheduleServiceDraft,
  type ScheduleTeamDraft,
} from "@/components/schedule-sheets";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { authClient } from "@/lib/auth-client";
import {
  createMobileRundown,
  createMobileScheduleAssignment,
  createMobileShowInventoryItem,
  copyMobileScheduleTeam,
  getMobileSchedule,
  remindAllMobileScheduleAssignments,
  remindMobileScheduleAssignment,
  removeMobileScheduleAssignment,
  removeMobileScheduleService,
  respondToMobileAssignment,
  saveMobileScheduleProvider,
  setMobileShowInventoryArchived,
  updateMobileScheduleAssignment,
  updateMobileScheduleService,
  type MobileSchedule,
} from "@/lib/mobile-api";
import { formatServiceTime, isServiceDate } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type Service = MobileSchedule["services"][number];
type Assignment = MobileSchedule["assignments"][number];
type EditorState =
  | { kind: "service"; service: Service | null; initialInventoryId?: string }
  | { kind: "assignment"; service: Service; assignment: Assignment | null }
  | { kind: "team"; service: Service }
  | { kind: "provider" }
  | { kind: "inventory" }
  | null;

function shiftServiceDate(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export default function ScheduleScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ date?: string; assignment?: string }>();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const requestedDate = isServiceDate(params.date) ? params.date : undefined;
  const requestedAssignmentId = typeof params.assignment === "string" && params.assignment.length > 0 && params.assignment.length <= 64 ? params.assignment : undefined;
  const [selectedDate, setSelectedDate] = useState<string | undefined>(requestedDate);
  const [dateInput, setDateInput] = useState(requestedDate ?? "");
  useEffect(() => {
    setSelectedDate(requestedDate);
    setDateInput(requestedDate ?? "");
  }, [requestedDate]);
  const query = useQuery({
    queryKey: ["mobile-schedule", organization?.id, selectedDate, requestedAssignmentId],
    queryFn: () => getMobileSchedule(organization!.id, { serviceDate: selectedDate, assignmentId: requestedAssignmentId }),
    enabled: Boolean(organization?.id),
    refetchInterval: 15_000,
  });
  const schedule = query.data;
  const focusedShowId = schedule?.assignments.find((assignment) => assignment.id === requestedAssignmentId)?.showId;
  const services = useMemo(() => {
    const rows = schedule?.services ?? [];
    if (!focusedShowId) return rows;
    return [...rows].sort((left, right) => Number(right.id === focusedShowId) - Number(left.id === focusedShowId));
  }, [focusedShowId, schedule?.services]);

  if (organizationPending) return <LoadingView label="Opening schedule…" />;
  if (!organization) return <Redirect href="/organizations" />;
  const orgId = organization.id;

  async function refreshSchedule() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap", orgId] }),
    ]);
  }

  async function saved() {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await refreshSchedule();
  }

  async function saveService(draft: ScheduleServiceDraft) {
    if (draft.expectedUpdatedAt && editor?.kind === "service" && editor.service) {
      await updateMobileScheduleService({
        orgId,
        showId: editor.service.id,
        name: draft.name,
        startTime: draft.startTime,
        location: draft.location,
        expectedUpdatedAt: draft.expectedUpdatedAt,
      });
    } else {
      await createMobileRundown({
        orgId,
        requestId: draft.requestId,
        serviceDate: draft.serviceDate,
        name: draft.name,
        startTime: draft.startTime || undefined,
        location: draft.location || undefined,
        inventoryId: draft.inventoryId,
        copyFrom: draft.copyFrom,
        copyFromShowId: draft.copyFromShowId,
      });
    }
    await saved();
  }

  async function saveAssignment(draft: ScheduleAssignmentDraft) {
    const result = draft.expectedUpdatedAt && editor?.kind === "assignment" && editor.assignment
      ? await updateMobileScheduleAssignment({
        orgId,
        assignmentId: editor.assignment.id,
        ...draft,
        expectedUpdatedAt: draft.expectedUpdatedAt,
      })
      : await createMobileScheduleAssignment({ orgId, ...draft });
    await saved();
    if (draft.crewMemberId && !result.delivered) {
      Alert.alert("Assignment saved", "The position is on the shared schedule, but ShowPilot could not deliver the invitation. Use Resend invite after checking the person’s email.");
    }
  }

  async function saveTeam(draft: ScheduleTeamDraft) {
    const results = await Promise.all(draft.rows.map((row) => createMobileScheduleAssignment({
      orgId,
      requestId: row.requestId,
      showId: draft.showId,
      role: row.role,
      department: draft.department,
      crewMemberId: row.crewMemberId,
      callTime: "",
      notes: "",
    })));
    await saved();
    const missed = results.filter((result) => !result.delivered).length;
    if (missed) Alert.alert("Team created", `${missed} invitation${missed === 1 ? " was" : "s were"} not delivered. Check those roster emails, then resend.`);
  }

  async function createInventoryItem(draft: ScheduleInventoryDraft) {
    await createMobileShowInventoryItem({ orgId, ...draft });
    await saved();
  }

  async function archiveInventoryItem(item: MobileSchedule["inventory"][number], archived: boolean) {
    await setMobileShowInventoryArchived({
      orgId,
      inventoryId: item.id,
      expectedUpdatedAt: item.updatedAt,
      archived,
    });
    await saved();
  }

  function copyTeam(service: Service, source: Service) {
    Alert.alert("Copy previous team?", `${source.name || "The previous show"} has ${source.crewTotal} position${source.crewTotal === 1 ? "" : "s"}. Everyone will receive a fresh invitation for ${service.name || "this show"}.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Copy and invite", onPress: () => void copyMobileScheduleTeam({
        orgId,
        showId: service.id,
        sourceShowId: source.id,
        requestId: `copy-${source.id.slice(0, 36)}-${service.id.slice(0, 36)}`,
      }).then(async (result) => {
        await saved();
        Alert.alert("Team copied", `${result.copied} position${result.copied === 1 ? "" : "s"} copied. ${result.delivered} of ${result.total} invitation${result.total === 1 ? "" : "s"} delivered.`);
      }).catch((error: Error) => Alert.alert("Team not copied", error.message)) },
    ]);
  }

  async function respond(assignmentId: string, response: "confirmed" | "declined") {
    setRespondingId(assignmentId);
    try {
      await respondToMobileAssignment({ orgId, assignmentId, response, reason: response === "declined" ? reason.trim() : "" });
      setDecliningId(null);
      setReason("");
      await saved();
    } catch (error) {
      Alert.alert("Response not saved", error instanceof Error ? error.message : "Try again.");
    } finally {
      setRespondingId(null);
    }
  }

  function removeAssignment(assignment: Assignment) {
    Alert.alert("Remove assignment?", `${assignment.role} will be removed from this show and its pending invitation will close.`, [
      { text: "Keep", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void removeMobileScheduleAssignment({ orgId, assignmentId: assignment.id }).then(saved).catch((error: Error) => Alert.alert("Assignment not removed", error.message)) },
    ]);
  }

  function removeService(service: Service) {
    Alert.alert("Delete show?", `${service.name || "This show"} and all of its rundown, assignments, checklist, cues, and incidents will be removed permanently.`, [
      { text: "Keep show", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void removeMobileScheduleService({ orgId, showId: service.id }).then(saved).catch((error: Error) => Alert.alert("Show not deleted", error.message)) },
    ]);
  }

  async function remindOne(assignment: Assignment) {
    try {
      const result = await remindMobileScheduleAssignment({ orgId, assignmentId: assignment.id });
      await saved();
      Alert.alert(result.delivered ? "Invitation sent" : "Invitation not delivered", result.delivered ? `${assignment.crewName ?? "The crew member"} received a fresh schedule invitation.` : "Check the roster email and make sure the response window is still open.");
    } catch (error) {
      Alert.alert("Reminder not sent", error instanceof Error ? error.message : "Try again.");
    }
  }

  async function remindAll(service: Service) {
    try {
      const result = await remindAllMobileScheduleAssignments({ orgId, showId: service.id });
      await saved();
      Alert.alert("Invitations processed", `${result.delivered} of ${result.total} pending invitation${result.total === 1 ? "" : "s"} delivered.`);
    } catch (error) {
      Alert.alert("Reminders not sent", error instanceof Error ? error.message : "Try again.");
    }
  }

  const canManage = Boolean(schedule?.canManage);
  const canManageAssignments = canManage && schedule?.provider.type === "native";
  function browse(date: string | undefined) {
    setSelectedDate(date);
    setDateInput(date ?? "");
    router.replace(date ? { pathname: "/schedule", params: { date } } : "/schedule");
  }
  const pageAction = <View style={styles.pageActions}>{schedule?.canViewFull ? <Pressable accessibilityLabel="Show inventory" onPress={() => setEditor({ kind: "inventory" })} style={styles.secondaryAction}><Boxes color={colors.textMuted} size={18} /></Pressable> : null}{canManage ? <Pressable accessibilityLabel="Schedule settings" onPress={() => setEditor({ kind: "provider" })} style={styles.secondaryAction}><Settings2 color={colors.textMuted} size={18} /></Pressable> : null}{canManage ? <Pressable accessibilityLabel="Create show" onPress={() => setEditor({ kind: "service", service: null })} style={styles.addButton}><Plus color={colors.black} size={20} /></Pressable> : null}</View>;

  return (
    <Page action={pageAction} eyebrow="CREW PLAN" title="Schedule" scroll={false}>
      <FlatList
        contentContainerStyle={styles.list}
        data={services}
        initialNumToRender={6}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(service) => service.id}
        ListHeaderComponent={<View style={styles.listHeader}>
          {schedule?.canViewFull ? <View style={styles.dateBrowser}><Pressable accessibilityLabel="Previous day" disabled={!selectedDate} onPress={() => selectedDate && browse(shiftServiceDate(selectedDate, -1))} style={styles.dateArrow}><ChevronLeft color={selectedDate ? colors.textMuted : colors.textFaint} size={18} /></Pressable><TextInput accessibilityLabel="Schedule date" autoCapitalize="none" keyboardType="numbers-and-punctuation" maxLength={10} onChangeText={setDateInput} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textFaint} style={styles.dateInput} value={dateInput} /><Pressable accessibilityRole="button" onPress={() => isServiceDate(dateInput) ? browse(dateInput) : Alert.alert("Invalid date", "Enter the date as YYYY-MM-DD.")} style={styles.dateGo}><Text style={styles.dateGoText}>Go</Text></Pressable><Pressable accessibilityLabel="Next day" disabled={!selectedDate} onPress={() => selectedDate && browse(shiftServiceDate(selectedDate, 1))} style={styles.dateArrow}><ChevronRight color={selectedDate ? colors.textMuted : colors.textFaint} size={18} /></Pressable><Pressable accessibilityRole="button" onPress={() => browse(undefined)} style={styles.rangeButton}><Text style={styles.rangeButtonText}>Range</Text></Pressable></View> : null}
          {schedule && schedule.provider.type !== "native" ? <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(schedule.provider.url).catch(() => Alert.alert("Could not open scheduling platform"))} style={styles.provider}><ExternalLink color={colors.amberText} size={17} /><View style={styles.providerCopy}><Text style={styles.providerTitle}>{schedule.provider.label || schedule.provider.type}</Text><Text numberOfLines={1} style={styles.providerUrl}>{schedule.provider.url}</Text></View><ChevronRight color={colors.textFaint} size={17} /></Pressable> : null}
          {schedule ? <View style={styles.stats}><Stat label="SHOWS" value={schedule.services.length} /><Stat label="POSITIONS" value={schedule.assignments.length} /><Stat label="CONFIRMED" value={schedule.assignments.filter((assignment) => assignment.status === "confirmed").length} /></View> : null}
          {query.isPending ? <ActivityIndicator color={colors.amber} size="large" /> : null}
          {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
        </View>}
        ListEmptyComponent={schedule && !query.isPending ? <View style={styles.emptyState}><CalendarPlus color={colors.textFaint} size={30} /><Text style={styles.empty}>No shows are scheduled in this range.</Text>{canManage ? <Pressable onPress={() => setEditor({ kind: "service", service: null })} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Schedule the first show</Text></Pressable> : null}</View> : null}
        maxToRenderPerBatch={6}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: service, index }) => {
          const assignments = (schedule?.assignments ?? []).filter((assignment) => assignment.showId === service.id);
          const previousWithTeam = [...services.slice(0, index)].reverse().find((candidate) => candidate.crewTotal > 0);
          return <View style={[styles.card, focusedShowId === service.id && styles.cardFocused]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${service.name}`} onPress={() => router.push({ pathname: "/show/[showId]", params: { showId: service.id } })} style={styles.serviceHeader}>
              <View style={styles.dateBlock}><Text style={styles.dateDay}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { day: "2-digit" })}</Text><Text style={styles.dateMonth}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { month: "short" }).toUpperCase()}</Text></View>
              <View style={styles.cardCopy}><Text style={styles.title}>{service.name || "Untitled show"}</Text><Text style={styles.fullDate}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</Text><View style={styles.meta}><Clock3 size={12} color={colors.textFaint} /><Text style={styles.metaText}>{formatServiceTime(service.scheduledStartTime, schedule?.timeZone ?? "UTC")}</Text>{service.location ? <><MapPin size={12} color={colors.textFaint} /><Text style={styles.metaText}>{service.location}</Text></> : null}</View></View><ChevronRight color={colors.textFaint} size={18} />
            </Pressable>
            <View style={styles.metrics}><Text style={styles.metric}>{service.completedItems}/{service.itemCount} rundown</Text><Text style={styles.metric}>{service.crewConfirmed}/{service.crewTotal} confirmed</Text>{service.crewOpen ? <Text style={styles.warning}>{service.crewOpen} open</Text> : null}{service.incidentCount ? <Text style={styles.danger}>{service.incidentCount} incidents</Text> : null}</View>
            {canManage ? <View style={styles.manageActions}><SmallAction icon={<Pencil color={colors.textMuted} size={14} />} label="Edit" onPress={() => setEditor({ kind: "service", service })} />{canManageAssignments ? <><SmallAction icon={<UserPlus color={colors.amberText} size={14} />} label="Position" onPress={() => setEditor({ kind: "assignment", service, assignment: null })} /><SmallAction icon={<Users color={colors.amberText} size={14} />} label="Team" onPress={() => setEditor({ kind: "team", service })} />{assignments.length === 0 && previousWithTeam ? <SmallAction icon={<Copy color={colors.textMuted} size={14} />} label="Copy team" onPress={() => copyTeam(service, previousWithTeam)} /> : null}{assignments.some((assignment) => assignment.status === "assigned" && assignment.crewMemberId && assignment.responseWindow.status === "open") ? <SmallAction icon={<Bell color={colors.textMuted} size={14} />} label="Remind" onPress={() => void remindAll(service)} /> : null}</> : null}<SmallAction danger icon={<Trash2 color={colors.red} size={14} />} label="Delete" onPress={() => removeService(service)} /></View> : null}
            {assignments.length ? <View style={styles.assignments}>{assignments.map((assignment) => <AssignmentRow assignment={assignment} canManage={canManageAssignments} declining={decliningId === assignment.id} focused={assignment.id === requestedAssignmentId} key={assignment.id} onCancel={() => { setDecliningId(null); setReason(""); }} onDecline={() => { setDecliningId(assignment.id); setReason(""); }} onEdit={() => setEditor({ kind: "assignment", service, assignment })} onReason={setReason} onRemind={() => void remindOne(assignment)} onRemove={() => removeAssignment(assignment)} onRespond={(response) => void respond(assignment.id, response)} pending={respondingId === assignment.id} reason={reason} />)}</View> : <Text style={styles.noAssignments}>{canManageAssignments ? "No positions yet. Add an open position or build a team." : "No crew assignments published."}</Text>}
          </View>;
        }}
        windowSize={7}
      />
      {editor?.kind === "service" && schedule ? <ScheduleServiceSheet initialInventoryId={editor.initialInventoryId} inventory={schedule.inventory} onClose={() => setEditor(null)} onSave={saveService} previousServices={[...schedule.services].filter((candidate) => candidate.serviceDate <= (editor.service?.serviceDate ?? schedule.to)).reverse()} service={editor.service} timeZone={schedule.timeZone} /> : null}
      {editor?.kind === "assignment" && schedule ? <ScheduleAssignmentSheet assignment={editor.assignment} crew={schedule.crew} onClose={() => setEditor(null)} onSave={saveAssignment} showId={editor.service.id} /> : null}
      {editor?.kind === "team" && schedule ? <ScheduleTeamSheet crew={schedule.crew} onClose={() => setEditor(null)} onSave={saveTeam} showId={editor.service.id} /> : null}
      {editor?.kind === "provider" && schedule ? <ScheduleProviderSheet current={schedule.provider} onClose={() => setEditor(null)} onSave={async (input) => { await saveMobileScheduleProvider({ orgId, provider: input.type, url: input.url, label: input.label, terminologyProfile: input.terminologyProfile }); await saved(); }} terminologyProfile={schedule.terminologyProfile} /> : null}
      {editor?.kind === "inventory" && schedule ? <ScheduleInventorySheet archivedInventory={schedule.archivedInventory} canManage={schedule.canManage} inventory={schedule.inventory} onArchive={archiveInventoryItem} onClose={() => setEditor(null)} onCreate={createInventoryItem} onUse={(inventoryId) => setEditor({ kind: "service", service: null, initialInventoryId: inventoryId })} savedTemplates={schedule.savedTemplates} /> : null}
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const styles = useStyles();
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function SmallAction({ danger = false, icon, label, onPress }: { danger?: boolean; icon: ReactNode; label: string; onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" onPress={onPress} style={styles.smallAction}>{icon}<Text style={[styles.smallActionText, danger && styles.smallActionDanger]}>{label}</Text></Pressable>;
}

function AssignmentRow({ assignment, canManage, focused, declining, reason, pending, onReason, onDecline, onCancel, onRespond, onEdit, onRemove, onRemind }: {
  assignment: Assignment;
  canManage: boolean;
  focused: boolean;
  declining: boolean;
  reason: string;
  pending: boolean;
  onReason: (value: string) => void;
  onDecline: () => void;
  onCancel: () => void;
  onRespond: (response: "confirmed" | "declined") => void;
  onEdit: () => void;
  onRemove: () => void;
  onRemind: () => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const responseClosed = assignment.status === "assigned" && assignment.responseWindow.status === "closed";
  const displayStatus = !assignment.crewMemberId ? "open" : responseClosed ? "closed" : assignment.status;
  const remindable = canManage && assignment.status === "assigned" && Boolean(assignment.crewMemberId) && assignment.responseWindow.status === "open";
  return <View accessibilityLabel={focused ? `Selected assignment: ${assignment.role}` : undefined} style={[styles.assignmentBlock, focused && styles.assignmentFocused]}>
    <View style={styles.assignment}><Users size={12} color={colors.textFaint} /><View style={styles.assignmentCopy}><Text style={styles.assignmentRole}>{assignment.role}</Text><Text style={styles.assignmentText}>{assignment.crewName || "Open position"}{assignment.callTime ? ` · Call ${assignment.callTime}` : ""}</Text></View><Text style={[styles.status, assignment.status === "confirmed" && styles.confirmed, (assignment.status === "declined" || responseClosed) && styles.declined]}>{displayStatus}</Text></View>
    {assignment.notes ? <Text style={styles.managerNote}>{assignment.notes}</Text> : null}
    {assignment.responseNote ? <View style={styles.responseNoteBox}><Text style={styles.responseNoteLabel}>CREW RESPONSE</Text><Text style={styles.responseNote}>{assignment.responseNote}</Text>{assignment.respondedAt ? <Text style={styles.responseDate}>{new Date(assignment.respondedAt).toLocaleString()}</Text> : null}</View> : null}
    {responseClosed ? <Text style={styles.closedNote}>The response window closed when this show ended.</Text> : null}
    {assignment.canRespond && assignment.status === "assigned" && !declining ? <View style={styles.responseActions}><ActionText disabled={pending} label="Accept" onPress={() => onRespond("confirmed")} tone="confirm" /><ActionText disabled={pending} label="Decline" onPress={onDecline} tone="decline" /></View> : null}
    {declining ? <View style={styles.declineForm}><TextInput accessibilityLabel={`Reason for declining ${assignment.role}`} maxLength={500} multiline onChangeText={onReason} placeholder="Tell the team why you cannot serve (optional)" placeholderTextColor={colors.textFaint} style={styles.reasonInput} value={reason} /><View style={styles.responseActions}><ActionText disabled={pending} label="Cancel" onPress={onCancel} tone="neutral" /><ActionText disabled={pending} label={pending ? "Saving…" : "Confirm decline"} onPress={() => onRespond("declined")} tone="decline" /></View></View> : null}
    {canManage ? <View style={styles.assignmentActions}><SmallAction icon={<Pencil color={colors.textMuted} size={13} />} label="Edit" onPress={onEdit} />{remindable ? <SmallAction icon={<Bell color={colors.textMuted} size={13} />} label="Resend" onPress={onRemind} /> : null}<SmallAction danger icon={<Trash2 color={colors.red} size={13} />} label="Remove" onPress={onRemove} /></View> : null}
  </View>;
}

function ActionText({ disabled, label, onPress, tone }: { disabled: boolean; label: string; onPress: () => void; tone: "confirm" | "decline" | "neutral" }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.responseButton, tone === "confirm" ? styles.confirmButton : tone === "decline" ? styles.declineButton : styles.neutralButton]}><Text style={tone === "confirm" ? styles.confirmText : tone === "decline" ? styles.declineText : styles.neutralText}>{label}</Text></Pressable>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  pageActions: { flexDirection: "row", gap: 8 },
  addButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  secondaryAction: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  list: { gap: 13, paddingBottom: spacing.large },
  listHeader: { gap: spacing.medium },
  dateBrowser: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 5 },
  dateArrow: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.small, backgroundColor: colors.panelStrong },
  dateInput: { minWidth: 94, flex: 1, color: colors.text, fontFamily, fontSize: 11, textAlign: "center", paddingHorizontal: 4 },
  dateGo: { minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.small, backgroundColor: colors.amberSoft, paddingHorizontal: 10 },
  dateGoText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900" },
  rangeButton: { minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9 },
  rangeButtonText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900" },
  provider: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 11, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, padding: 12 },
  providerCopy: { flex: 1, minWidth: 0, gap: 3 },
  providerTitle: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "900", textTransform: "capitalize" },
  providerUrl: { color: colors.textMuted, fontFamily, fontSize: 11 },
  stats: { flexDirection: "row", overflow: "hidden", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  stat: { flex: 1, alignItems: "center", gap: 3, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.border, paddingVertical: 10 },
  statValue: { color: colors.text, fontFamily, fontSize: 17, fontWeight: "900" },
  statLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.7 },
  card: { overflow: "hidden", borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  cardFocused: { borderColor: colors.amberBorder },
  serviceHeader: { minHeight: 86, flexDirection: "row", alignItems: "center", gap: 12, padding: spacing.medium },
  dateBlock: { width: 49, height: 55, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amberSoft },
  dateDay: { color: colors.amberText, fontFamily, fontSize: 20, fontWeight: "900" },
  dateMonth: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  cardCopy: { flex: 1, minWidth: 0, gap: 4 },
  title: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "900" },
  fullDate: { color: colors.textMuted, fontFamily, fontSize: 11 },
  meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  metaText: { color: colors.textFaint, fontFamily, fontSize: 11, marginRight: 4 },
  metrics: { flexDirection: "row", flexWrap: "wrap", gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingHorizontal: spacing.medium, paddingVertical: 9 },
  metric: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.panelStrong, color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800", paddingHorizontal: 7, paddingVertical: 4 },
  warning: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.amberSoft, color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", paddingHorizontal: 7, paddingVertical: 4 },
  danger: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.redSoft, color: colors.red, fontFamily, fontSize: 11, fontWeight: "900", paddingHorizontal: 7, paddingVertical: 4 },
  manageActions: { flexDirection: "row", flexWrap: "wrap", gap: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, padding: 8 },
  smallAction: { minHeight: 38, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 9 },
  smallActionText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  smallActionDanger: { color: colors.red },
  assignments: { gap: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, padding: 9 },
  noAssignments: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, padding: 12 },
  assignmentBlock: { gap: 7, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, padding: 10 },
  assignmentFocused: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  assignment: { flexDirection: "row", alignItems: "center", gap: 7 },
  assignmentCopy: { flex: 1, minWidth: 0, gap: 2 },
  assignmentRole: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "900" },
  assignmentText: { color: colors.textMuted, fontFamily, fontSize: 11 },
  status: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  confirmed: { color: colors.green },
  declined: { color: colors.red },
  managerNote: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16 },
  responseNoteBox: { minWidth: 0, gap: 4, borderRadius: radii.small, backgroundColor: colors.redSoft, padding: 9 },
  responseNoteLabel: { color: colors.red, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  responseNote: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 11, lineHeight: 16 },
  responseDate: { color: colors.textFaint, fontFamily, fontSize: 11 },
  closedNote: { color: colors.red, fontFamily, fontSize: 11, lineHeight: 16 },
  responseActions: { flexDirection: "row", justifyContent: "flex-end", gap: 7 },
  responseButton: { minHeight: 42, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, paddingHorizontal: 13 },
  confirmButton: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  confirmText: { color: colors.green, fontFamily, fontSize: 11, fontWeight: "900" },
  declineButton: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  declineText: { color: colors.red, fontFamily, fontSize: 11, fontWeight: "900" },
  neutralButton: { borderColor: colors.border, backgroundColor: colors.panelStrong },
  neutralText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900" },
  declineForm: { gap: 8 },
  reasonInput: { minHeight: 76, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 12, lineHeight: 18, padding: 10, textAlignVertical: "top" },
  assignmentActions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 5, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingTop: 7 },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  emptyState: { alignItems: "center", gap: 10, paddingVertical: 34 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, textAlign: "center" },
  emptyButton: { minHeight: 42, justifyContent: "center", borderRadius: radii.medium, backgroundColor: colors.amber, paddingHorizontal: 15 },
  emptyButtonText: { color: colors.black, fontFamily, fontSize: 11, fontWeight: "900" },
}));
