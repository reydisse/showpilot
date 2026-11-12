import { ShowManagementSheet } from "@/components/show-management-sheet";
import { useShowManagementDrafts } from "@/hooks/use-show-management";
import { showDraftFromSnapshot, type ShowManagementDraft } from "@/lib/show-management-recovery";
import { ShowCreationSheet } from "@/components/show-creation-sheet";
import { useShowCreationDrafts } from "@/hooks/use-show-creation";
import type { ShowCreationDraft } from "@/lib/show-creation-recovery";
import { useTeamDrafts } from "@/hooks/use-mobile-team";
import type { TeamDraft } from "@/lib/team-recovery";
import { useAssignmentDrafts } from "@/hooks/use-mobile-assignment";
import type { AssignmentDraft } from "@/lib/assignment-recovery";
import { AppButton } from "@/components/app-button";
import { useMobileCopy } from "@/hooks/use-mobile-copy";
import { ScheduleCopyProgress } from "@/components/schedule-copy-progress";
import type { CopyTeamSelection } from "@/lib/copy-recovery";
import { useMobileReminders, reminderSlot } from "@/hooks/use-mobile-reminders";
import { ScheduleReminderProgress } from "@/components/schedule-reminder-progress";
import type { ReminderTarget } from "@/lib/reminder-recovery";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/providers/workspace-provider";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { ActivityIndicator, Alert, FlatList, useWindowDimensions, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  ScheduleAssignmentSheet,
  ScheduleInventorySheet,
  ScheduleProviderSheet,
  ScheduleTeamSheet,
} from "@/components/schedule-sheets";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { authClient } from "@/lib/auth-client";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import {
  commandMobileInventory,
  commandMobileAssignment,
  readMobileAssignment,
  copyMobileScheduleTeam,
  getMobileSchedule,
  sendMobileScheduleReminders,
  respondToMobileAssignment,
  saveMobileScheduleProvider,
  type MobileSchedule,
} from "@/lib/mobile-api";
import { formatServiceTime, getServiceDateForTimeZone, isServiceDate, serviceWallTimeInput } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type Service = MobileSchedule["services"][number];
type Assignment = MobileSchedule["assignments"][number];
type EditorState =
  | { kind: "showManagement"; initial: ShowManagementDraft }
  | { kind: "createShow"; initial: ShowCreationDraft }
  | { kind: "assignment"; initial: AssignmentDraft }
  | { kind: "team"; initial: TeamDraft }
  | { kind: "provider" }
  | { kind: "inventory" }
  | null;

function shiftServiceDate(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export default function ScheduleScreen() {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending) return <LoadingView label="Opening schedule…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return <ScheduleWorkspace key={`${session.user.id}:${organization.id}`} orgId={organization.id} userId={session.user.id} />;
}
function ScheduleWorkspace({ orgId, userId }: { orgId: string; userId: string }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ date?: string; assignment?: string }>();
  const list = useRef<FlatList<Service>>(null);
  const { width, fontScale } = useWindowDimensions();
  const narrowHeader = width / fontScale < 400;
  const queryClient = useQueryClient();
  const assignmentDrafts = useAssignmentDrafts({ orgId, userId });
  const showManagementDrafts = useShowManagementDrafts({ orgId, userId });
  const showDrafts = useShowCreationDrafts({ orgId, userId });
  const teamDrafts = useTeamDrafts({ orgId, userId });
  const [editor, setEditor] = useState<EditorState>(null);
  const [copyConfirmation, setCopyConfirmation] = useState<{ selection: CopyTeamSelection; label: string; count: number; again: boolean } | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const requestedDate = isServiceDate(params.date) ? params.date : undefined;
  const requestedAssignmentId = typeof params.assignment === "string" && params.assignment.length > 0 && params.assignment.length <= 64 ? params.assignment : undefined;
  const [selectedDate, setSelectedDate] = useState<string | undefined>(requestedDate);
  const [dateInput, setDateInput] = useState(requestedDate ?? "");
  const pollingInterval = useScreenPollingInterval(15_000);
  useEffect(() => { if (pollingInterval === false) setCopyConfirmation(null); }, [pollingInterval]);
  useEffect(() => {
    setSelectedDate(requestedDate);
    setDateInput(requestedDate ?? "");
  }, [requestedDate]);
  const query = useQuery({
    queryKey: ["mobile-schedule", orgId, selectedDate, requestedAssignmentId],
    queryFn: () => getMobileSchedule(orgId, { serviceDate: selectedDate, assignmentId: requestedAssignmentId }),
    enabled: Boolean(orgId),
    refetchInterval: pollingInterval,
  });
  const schedule = query.data;
  const focusedShowId = schedule?.assignments.find((assignment) => assignment.id === requestedAssignmentId)?.showId;
  const services = useMemo(() => {
    const rows = schedule?.services ?? [];
    if (!focusedShowId) return rows;
    return [...rows].sort((left, right) => Number(right.id === focusedShowId) - Number(left.id === focusedShowId));
  }, [focusedShowId, schedule?.services]);

  const reminders = useMobileReminders({ orgId, userId }, {
    enabled: pollingInterval !== false,
    send: sendMobileScheduleReminders,
    refresh: async (signal) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] }, { throwOnError: true }),
      ]);
      if (signal.aborted) throw new Error("Reminder view closed.");
    },
  });
  function startReminder(target: ReminderTarget, label: string) {
    reminders.start(target, label);
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }
  const canSendReminder = (target: ReminderTarget) => Boolean(schedule?.canManage && schedule.provider.type === "native" && schedule.assignments.some(assignment =>
    (target.kind === "show" ? assignment.showId === target.id : assignment.id === target.id) && assignment.status === "assigned" && assignment.crewMemberId && assignment.responseWindow.status === "open"));

  async function refreshSchedule() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }),
      queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] }),
    ]);
  }

  async function saved() {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await refreshSchedule();
  }

  function openShowManagement(service: Service, mode: "edit" | "delete") {
    setEditor({ kind: "showManagement", initial: showDraftFromSnapshot(mode, service, schedule?.timeZone ?? "UTC") });
  }

  function openShowCreation(inventoryId?: string) {
    const item = schedule?.inventory.find(item => item.id === inventoryId);
    const timeZone = schedule?.timeZone ?? "UTC";
    setEditor({ kind: "createShow", initial: showDrafts[0] ?? {
      serviceDate: selectedDate ?? getServiceDateForTimeZone(timeZone), timeZone,
      name: item?.name ?? "", startTime: item?.defaultStartTime ?? "", callTime: "", location: item?.location ?? "",
      source: item ? { kind: "inventory", id: item.id, name: item.name } : { kind: "blank" },
    } });
  }

  function openAssignment(service: Service, assignment: Assignment | null, remove = false) {
    const timeZone = schedule?.timeZone ?? "UTC";
    const initial: AssignmentDraft = {
      editorId: assignment ? `${remove ? "delete" : "edit"}:${assignment.id}` : `create:${service.id}`,
      mode: remove ? "delete" : assignment ? "edit" : "create",
      showName: service.name || "Untitled show",
      fields: { showId: service.id, serviceDate: service.serviceDate, timeZone,
        role: assignment?.role ?? "", department: assignment?.department ?? "Production", crewMemberId: assignment?.crewMemberId ?? null,
        callTime: assignment?.callTime ? /^([01]\d|2[0-3]):[0-5]\d$/.test(assignment.callTime) ? assignment.callTime : serviceWallTimeInput(assignment.callTime, timeZone) : "",
        notes: assignment?.notes ?? "" },
      base: assignment ? { id: assignment.id, revision: assignment.revision ?? null, status: assignment.status, crewMemberId: assignment.crewMemberId, responseNote: assignment.responseNote } : null,
    };
    setEditor({ kind: "assignment", initial });
  }

  function openTeam(service: Service) {
    setEditor({ kind: "team", initial: { showId: service.id, serviceDate: service.serviceDate, showName: service.name || "Untitled show", timeZone: schedule?.timeZone ?? "UTC", department: "", rows: [] } });
  }

  const copies = useMobileCopy({ orgId, userId }, {
    enabled: pollingInterval !== false,
    send: copyMobileScheduleTeam,
    refresh: async signal => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }, { throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] }, { throwOnError: true }),
      ]);
      if (signal.aborted) throw new Error("Copy view closed.");
    },
  });
  function canCopyAgain(selection: CopyTeamSelection) {
    const target = schedule?.services.find(service => service.id === selection.showId && service.serviceDate === selection.serviceDate);
    const source = schedule?.services.find(service => service.id === selection.copyFromShowId && service.serviceDate === selection.copyFrom);
    return Boolean(schedule?.canManage && schedule.provider.type === "native" && target && source && target.crewTotal === 0 && source.crewTotal > 0 && !["running", "paused"].includes(target.status));
  }
  function copyTeam(service: Service, source: Service) {
    const selection = { showId: service.id, serviceDate: service.serviceDate, copyFromShowId: source.id, copyFrom: source.serviceDate };
    const label = `${source.name || "Previous show"} (${source.serviceDate}) → ${service.name || "This show"} (${service.serviceDate})`;
    setCopyConfirmation({ selection, label, count: source.crewTotal, again: false });
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }
  function copyAgain(slot: string) {
    const attempt = copies.work[slot];
    if (!attempt || !canCopyAgain(attempt.command)) return;
    const source = schedule?.services.find(service => service.id === attempt.command.copyFromShowId);
    setCopyConfirmation({ selection: attempt.command, label: attempt.label, count: source?.crewTotal ?? 0, again: true });
    list.current?.scrollToOffset({ offset: 0, animated: false });
  }

  async function respond(assignment: Assignment, response: "confirmed" | "declined") {
    setRespondingId(assignment.id);
    try {
      await respondToMobileAssignment({
        orgId,
        assignmentId: assignment.id,
        reviewedVersion: assignment.responseVersion,
        response,
        reason: response === "declined" ? reason.trim() : "",
      });
      setDecliningId(null);
      setReason("");
      await saved();
    } catch (error) {
      Alert.alert("Response not saved", error instanceof Error ? error.message : "Try again.");
    } finally {
      setRespondingId(null);
    }
  }

  const canManage = Boolean(schedule?.canManage);
  const canManageAssignments = canManage && schedule?.provider.type === "native";
  function browse(date: string | undefined) {
    setSelectedDate(date);
    setDateInput(date ?? "");
    router.replace(date ? { pathname: "/schedule", params: { date } } : "/schedule");
  }
  const pageAction = (
    <View style={styles.pageActions}>
      {schedule?.canViewFull ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Show inventory" onPress={() => setEditor({ kind: "inventory" })} style={styles.secondaryAction}><Boxes color={colors.textMuted} size={18} /></Pressable>
      ) : null}
      {canManage ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Schedule settings" onPress={() => setEditor({ kind: "provider" })} style={styles.secondaryAction}><Settings2 color={colors.textMuted} size={18} /></Pressable>
      ) : null}
      {canManage ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Create show" onPress={() => openShowCreation()} style={styles.addButton}><Plus color={colors.black} size={20} /></Pressable>
      ) : null}
    </View>
  );

  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" action={narrowHeader ? undefined : pageAction} eyebrow="CREW PLAN" title="Schedule" scroll={false}>
      {narrowHeader ? pageAction : null}
      <FlatList ref={list}
        contentContainerStyle={styles.list}
        data={services}
        initialNumToRender={6}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(service) => service.id}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {schedule?.canViewFull ? (
              <View style={styles.dateBrowser}><Pressable accessibilityLabel="Previous day" disabled={!selectedDate} onPress={() => selectedDate && browse(shiftServiceDate(selectedDate, -1))} style={styles.dateArrow}><ChevronLeft color={selectedDate ? colors.textMuted : colors.textFaint} size={18} /></Pressable><TextInput accessibilityLabel="Schedule date" autoCapitalize="none" keyboardType="numbers-and-punctuation" maxLength={10} onChangeText={setDateInput} placeholder="YYYY-MM-DD" placeholderTextColor={colors.textFaint} style={styles.dateInput} value={dateInput} /><Pressable accessibilityRole="button" onPress={() => isServiceDate(dateInput) ? browse(dateInput) : Alert.alert("Invalid date", "Enter the date as YYYY-MM-DD.")} style={styles.dateGo}><Text style={styles.dateGoText}>Go</Text></Pressable><Pressable accessibilityLabel="Next day" disabled={!selectedDate} onPress={() => selectedDate && browse(shiftServiceDate(selectedDate, 1))} style={styles.dateArrow}><ChevronRight color={selectedDate ? colors.textMuted : colors.textFaint} size={18} /></Pressable><Pressable accessibilityRole="button" onPress={() => browse(undefined)} style={styles.rangeButton}><Text style={styles.rangeButtonText}>Range</Text></Pressable></View>
            ) : null}
            {schedule && schedule.provider.type !== "native" ? (
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(schedule.provider.url).catch(() => Alert.alert("Could not open scheduling platform"))} style={styles.provider}><ExternalLink color={colors.amberText} size={17} /><View style={styles.providerCopy}><Text style={styles.providerTitle}>{schedule.provider.label || schedule.provider.type}</Text><Text numberOfLines={1} style={styles.providerUrl}>{schedule.provider.url}</Text></View><ChevronRight color={colors.textFaint} size={17} /></Pressable>
            ) : null}
            {copyConfirmation ? <View style={styles.copyConfirmation}>
              <Text style={styles.copyTitle}>Copy team and send invitations?</Text>
              <Text style={styles.copyMessage}>{copyConfirmation.label}</Text>
              <Text style={styles.copyMessage}>{copyConfirmation.count} positions will be copied. New invitations will be sent for assigned positions.{copyConfirmation.again ? " Earlier invitations may already have arrived." : ""}</Text>
              {!canCopyAgain(copyConfirmation.selection) ? <Text accessibilityRole="alert" style={styles.error}>The show selection changed or the destination is not empty and stopped. Cancel and review the schedule.</Text> : null}
              <AppButton disabled={!canCopyAgain(copyConfirmation.selection)} label="Copy and invite" onPress={() => {
                if (!canCopyAgain(copyConfirmation.selection)) return;
                if (copyConfirmation.again) copies.another(copyConfirmation.selection.showId);
                else copies.start(copyConfirmation.selection, copyConfirmation.label);
                setCopyConfirmation(null);
              }} />
              <AppButton variant="secondary" label="Cancel team copy" onPress={() => setCopyConfirmation(null)} />
            </View> : null}
            <ScheduleCopyProgress copies={copies} canCopyAgain={canCopyAgain} onCopyAgain={copyAgain} />
            <ScheduleReminderProgress reminders={reminders} canSendNew={canSendReminder} />
            {showManagementDrafts.map(draft => <AppButton key={draft.showId} variant="secondary" label={`Resume ${draft.mode === "delete" ? "show deletion" : "show edit"}: ${draft.base.name || "Untitled show"} (${draft.base.serviceDate})`} onPress={() => setEditor({ kind: "showManagement", initial: draft })} />)}
            {showDrafts[0] ? <AppButton variant="secondary" label={`Resume show: ${showDrafts[0].name || "Untitled show"} (${showDrafts[0].serviceDate})`} onPress={() => openShowCreation()} /> : null}
            {teamDrafts.map(draft => <AppButton key={draft.showId} variant="secondary" label={`Resume team: ${draft.department || "New team"} · ${draft.showName} (${draft.serviceDate})`} onPress={() => setEditor({ kind: "team", initial: draft })} />)}
            {assignmentDrafts.map(draft => <AppButton key={draft.editorId} variant="secondary" label={`Resume ${draft.mode === "delete" ? "removal" : "assignment"}: ${draft.fields.role || "New position"} · ${draft.showName} (${draft.fields.serviceDate})`} onPress={() => setEditor({ kind: "assignment", initial: draft })} />) }
            {schedule ? (
              <View style={styles.stats}><Stat label="SHOWS" value={schedule.services.length} /><Stat label="POSITIONS" value={schedule.assignments.length} /><Stat label="CONFIRMED" value={schedule.assignments.filter((assignment) => assignment.status === "confirmed").length} /></View>
            ) : null}
            {query.isPending ? (
              <ActivityIndicator color={colors.amber} size="large" />
            ) : null}
            {query.error ? (
              <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          schedule && !query.isPending ? (
            <View style={styles.emptyState}>
              <CalendarPlus color={colors.textFaint} size={30} />
              <Text style={styles.empty}>No shows are scheduled in this range.</Text>
              {canManage ? (
                <Pressable onPress={() => openShowCreation()} style={styles.emptyButton}><Text style={styles.emptyButtonText}>Schedule the first show</Text></Pressable>
              ) : null}
            </View>
          ) : null
        }
        maxToRenderPerBatch={6}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: service, index }) => {
          const assignments = (schedule?.assignments ?? []).filter((assignment) => assignment.showId === service.id);
          const previousWithTeam = [...services.slice(0, index)].reverse().find((candidate) => candidate.crewTotal > 0);
          return (
            <View style={[styles.card, focusedShowId === service.id && styles.cardFocused]}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open ${service.name}`} onPress={() => router.push({ pathname: "/show/[showId]", params: { showId: service.id } })} style={styles.serviceHeader}>
                <View style={styles.dateBlock}><Text style={styles.dateDay}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { day: "2-digit" })}</Text><Text style={styles.dateMonth}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { month: "short" }).toUpperCase()}</Text></View>
                <View style={styles.cardCopy}>
                  <Text style={styles.title}>{service.name || "Untitled show"}</Text>
                  <Text style={styles.fullDate}>{new Date(`${service.serviceDate}T12:00:00`).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</Text>
                  <View style={styles.meta}>
                    <Clock3 size={12} color={colors.textFaint} />
                    <Text style={styles.metaText}>{formatServiceTime(service.scheduledStartTime, schedule?.timeZone ?? "UTC")}</Text>
                    {service.location ? (
                      <><MapPin size={12} color={colors.textFaint} /><Text style={styles.metaText}>{service.location}</Text></>
                    ) : null}
                  </View>
                </View>
                <ChevronRight color={colors.textFaint} size={18} />
              </Pressable>
              <View style={styles.metrics}>
                <Text style={styles.metric}>{service.completedItems}/{service.itemCount} rundown</Text>
                <Text style={styles.metric}>{service.crewConfirmed}/{service.crewTotal} confirmed</Text>
                {service.crewOpen ? (
                  <Text style={styles.warning}>{service.crewOpen} open</Text>
                ) : null}
                {service.incidentCount ? (
                  <Text style={styles.danger}>{service.incidentCount} incidents</Text>
                ) : null}
              </View>
              {canManage ? (
                <View style={styles.manageActions}>
                  <SmallAction icon={<Pencil color={colors.textMuted} size={14} />} label="Edit" onPress={() => openShowManagement(service, "edit")} />
                  {canManageAssignments ? (
                    <>
                      <SmallAction icon={<UserPlus color={colors.amberText} size={14} />} label="Position" onPress={() => openAssignment(service, null)} />
                      <SmallAction icon={<Users color={colors.amberText} size={14} />} label="Team" onPress={() => openTeam(service)} />
                      {assignments.length === 0 && previousWithTeam ? (
                        <SmallAction disabled={!!copies.work[service.id]} icon={<Copy color={colors.textMuted} size={14} />} label={copies.work[service.id] ? "Copy status above" : "Copy team"} onPress={() => copyTeam(service, previousWithTeam)} />
                      ) : null}
                      {assignments.some((assignment) => assignment.status === "assigned" && assignment.crewMemberId && assignment.responseWindow.status === "open") ? (
                        <SmallAction disabled={!!reminders.work[reminderSlot({ kind: "show", id: service.id })]} icon={<Bell color={colors.textMuted} size={14} />} label={reminders.work[reminderSlot({ kind: "show", id: service.id })] ? "Reminder status above" : "Remind"} onPress={() => startReminder({ kind: "show", id: service.id }, `Reminders for ${service.name || "this show"}`)} />
                      ) : null}
                    </>
                  ) : null}
                  <SmallAction danger icon={<Trash2 color={colors.red} size={14} />} label="Delete" onPress={() => openShowManagement(service, "delete")} />
                </View>
              ) : null}
              {assignments.length ? (
                <View style={styles.assignments}>
                  {assignments.map((assignment) => (
                    <AssignmentRow assignment={assignment} canManage={canManageAssignments} declining={decliningId === assignment.id} focused={assignment.id === requestedAssignmentId} key={assignment.id} onCancel={() => { setDecliningId(null); setReason(""); }} onDecline={() => { setDecliningId(assignment.id); setReason(""); }} onEdit={() => openAssignment(service, assignment)} onReason={setReason} reminderStarted={!!reminders.work[reminderSlot({ kind: "assignment", id: assignment.id })]} onRemind={() => startReminder({ kind: "assignment", id: assignment.id }, `${assignment.role} · ${assignment.crewName ?? "Crew"}`)} onRemove={() => openAssignment(service, assignment, true)} onRespond={(response) => void respond(assignment, response)} pending={respondingId === assignment.id} reason={reason} />
                  ))}
                </View>
              ) : (
                <Text style={styles.noAssignments}>{canManageAssignments ? "No positions yet. Add an open position or build a team." : "No crew assignments published."}</Text>
              )}
            </View>
          );
        }}
        windowSize={7}
      />
      {editor?.kind === "showManagement" ? <ShowManagementSheet key={`${userId}:${orgId}:${editor.initial.showId}`} orgId={orgId} userId={userId} initial={editor.initial} onClose={() => setEditor(null)} /> : null}
      {editor?.kind === "createShow" ? <ShowCreationSheet key={`${userId}:${orgId}`} orgId={orgId} userId={userId} initial={editor.initial} inventory={schedule?.inventory} shows={schedule?.services} onClose={() => setEditor(null)} /> : null}
      {editor?.kind === "assignment" ? (
        <ScheduleAssignmentSheet key={`${userId}:${orgId}:${editor.initial.editorId}`} orgId={orgId} userId={userId} active={pollingInterval !== false} initial={editor.initial} crew={schedule?.crew ?? []} onClose={() => setEditor(null)} onCommand={commandMobileAssignment} onRead={readMobileAssignment} onRefresh={async signal => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }, { throwOnError: true }),
            queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] }, { throwOnError: true }),
          ]);
          if (signal.aborted) throw new Error("Assignment refresh cancelled.");
        }} />
      ) : null}
      {editor?.kind === "team" ? (
        <ScheduleTeamSheet key={`${userId}:${orgId}:${editor.initial.showId}`} orgId={orgId} userId={userId} initial={editor.initial} active={pollingInterval !== false} crew={schedule?.crew ?? []} onClose={() => setEditor(null)} onCommand={commandMobileAssignment} onRefresh={async signal => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }, { throwOnError: true }),
            queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] }, { throwOnError: true }),
          ]);
          if (signal.aborted) throw new Error("Team refresh cancelled.");
        }} />
      ) : null}
      {editor?.kind === "provider" && schedule ? (
        <ScheduleProviderSheet
          current={schedule.provider}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            await saveMobileScheduleProvider({
              orgId,
              provider: input.type,
              url: input.url,
              label: input.label,
            });
            await saved();
          }}
        />
      ) : null}
      {editor?.kind === "inventory" && schedule ? (
        <ScheduleInventorySheet key={`${userId}:${orgId}`} orgId={orgId} userId={userId} active={pollingInterval !== false} onCommand={commandMobileInventory} onRefresh={async (signal) => {
          await queryClient.invalidateQueries({ queryKey: ["mobile-schedule", orgId] }, { throwOnError: true });
          if (signal.aborted) throw new Error("Inventory refresh cancelled.");
        }} archivedInventory={schedule.archivedInventory} canManage={schedule.canManage} inventory={schedule.inventory} onClose={() => setEditor(null)} onUse={(inventoryId) => openShowCreation(inventoryId)} savedTemplates={schedule.savedTemplates} />
      ) : null}
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const styles = useStyles();
  return (
    <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>
  );
}

function SmallAction({ danger = false, disabled = false, icon, label, onPress }: {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.smallAction, disabled && styles.disabledAction]}>{icon}<Text style={[styles.smallActionText, danger && styles.smallActionDanger]}>{label}</Text></Pressable>
  );
}

function AssignmentRow({ assignment, canManage, focused, declining, reason, pending, onReason, onDecline, onCancel, onRespond, onEdit, onRemove, onRemind, reminderStarted }: {
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
  reminderStarted: boolean;
}) {
  const workspaceTerms = useWorkspaceTerms();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const responseClosed = assignment.status === "assigned" && assignment.responseWindow.status === "closed";
  const displayStatus = !assignment.crewMemberId ? "open" : responseClosed ? "closed" : assignment.status;
  const remindable = canManage && assignment.status === "assigned" && Boolean(assignment.crewMemberId) && assignment.responseWindow.status === "open";
  return (
    <View accessibilityLabel={focused ? `Selected assignment: ${assignment.role}` : undefined} style={[styles.assignmentBlock, focused && styles.assignmentFocused]}>
      <View style={styles.assignment}><Users size={12} color={colors.textFaint} /><View style={styles.assignmentCopy}><Text style={styles.assignmentRole}>{assignment.role}</Text><Text style={styles.assignmentText}>{assignment.crewName || "Open position"}{assignment.callTime ? ` · Call ${assignment.callTime}` : ""}</Text></View><Text style={[styles.status, assignment.status === "confirmed" && styles.confirmed, (assignment.status === "declined" || responseClosed) && styles.declined]}>{displayStatus}</Text></View>
      {assignment.notes ? (
        <Text style={styles.managerNote}>{assignment.notes}</Text>
      ) : null}
      {assignment.responseNote ? (
        <View style={styles.responseNoteBox}>
          <Text style={styles.responseNoteLabel}>CREW RESPONSE</Text>
          <Text style={styles.responseNote}>{assignment.responseNote}</Text>
          {assignment.respondedAt ? (
            <Text style={styles.responseDate}>{new Date(assignment.respondedAt).toLocaleString()}</Text>
          ) : null}
        </View>
      ) : null}
      {responseClosed ? (
        <Text style={styles.closedNote}>The response window closed when this show ended.</Text>
      ) : null}
      {assignment.canRespond && assignment.status === "assigned" && !declining ? (
        <View style={styles.responseActions}><ActionText disabled={pending} label="Accept" onPress={() => onRespond("confirmed")} tone="confirm" /><ActionText disabled={pending} label="Decline" onPress={onDecline} tone="decline" /></View>
      ) : null}
      {declining ? (
        <View style={styles.declineForm}>
          <TextInput
            accessibilityLabel={`Reason for declining ${assignment.role}`}
            maxLength={500}
            multiline
            onChangeText={onReason}
            placeholder={workspaceCopy(
              "Tell the team why you cannot serve (optional)",
              workspaceTerms,
            )}
            placeholderTextColor={colors.textFaint}
            style={styles.reasonInput}
            value={reason}
          />
          <View style={styles.responseActions}><ActionText disabled={pending} label="Cancel" onPress={onCancel} tone="neutral" /><ActionText disabled={pending} label={pending ? "Saving…" : "Confirm decline"} onPress={() => onRespond("declined")} tone="decline" /></View>
        </View>
      ) : null}
      {canManage ? (
        <View style={styles.assignmentActions}>
          <SmallAction icon={<Pencil color={colors.textMuted} size={13} />} label="Edit" onPress={onEdit} />
          {remindable ? (
            <SmallAction disabled={reminderStarted} icon={<Bell color={colors.textMuted} size={13} />} label={reminderStarted ? "Reminder status above" : "Resend"} onPress={onRemind} />
          ) : null}
          <SmallAction danger icon={<Trash2 color={colors.red} size={13} />} label="Remove" onPress={onRemove} />
        </View>
      ) : null}
    </View>
  );
}

function ActionText({ disabled, label, onPress, tone }: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  tone: "confirm" | "decline" | "neutral";
}) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.responseButton, tone === "confirm" ? styles.confirmButton : tone === "decline" ? styles.declineButton : styles.neutralButton]}><Text style={tone === "confirm" ? styles.confirmText : tone === "decline" ? styles.declineText : styles.neutralText}>{label}</Text></Pressable>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  copyConfirmation: { gap: 12, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.panel },
  copyTitle: { color: colors.text, fontFamily, fontSize: 16, lineHeight: 22, fontWeight: "700" },
  copyMessage: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20 },
  pageActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  addButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  secondaryAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
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
  disabledAction: { opacity: 0.45 },
  smallAction: { minHeight: 44, minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 9 },
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
