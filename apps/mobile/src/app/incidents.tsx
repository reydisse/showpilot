import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import CircleDot from "lucide-react-native/icons/circle-dot";
import Eye from "lucide-react-native/icons/eye";
import Hand from "lucide-react-native/icons/hand";
import Archive from "lucide-react-native/icons/archive";
import MessageCircle from "lucide-react-native/icons/message-circle";
import MessageCirclePlus from "lucide-react-native/icons/message-circle-plus";
import Pencil from "lucide-react-native/icons/pencil";
import Plus from "lucide-react-native/icons/plus";
import Search from "lucide-react-native/icons/search";
import Send from "lucide-react-native/icons/send";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserRound from "lucide-react-native/icons/user-round";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";
import { Redirect, useRouter } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { authClient } from "@/lib/auth-client";
import {
  addMobileIncidentComment,
  commandMobileIncident,
  getMobileIncidents,
  removeMobileIncident,
  reportMobileIncident,
  setMobileIncidentCommentReaction,
  updateMobileIncident,
  type MobileIncidentComment,
  type MobileIncidentReaction,
  type MobileIncidentReactionEmoji,
  type MobileIncidents,
} from "@/lib/mobile-api";
import { getServiceDateForTimeZone } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const categories = ["audio", "video", "stream", "lighting", "other"] as const;
const severities = ["low", "medium", "high"] as const;
type IncidentFilter = "open" | "resolved" | "all";
type MobileIncident = MobileIncidents["incidents"][number];
const reactionEmojis: readonly MobileIncidentReactionEmoji[] = ["👍", "❤️", "🎉", "👀", "🙏"];

function createLocalRequestId() {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isIncidentCategory(value: string): value is (typeof categories)[number] {
  return categories.some((category) => category === value);
}

function isIncidentSeverity(value: string): value is (typeof severities)[number] {
  return severities.some((severity) => severity === value);
}

export default function IncidentsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const router = useRouter();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: bootstrap } = useMobileBootstrap();
  const queryClient = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<IncidentFilter>("open");
  const [search, setSearch] = useState("");
  const [assigningIncident, setAssigningIncident] = useState<MobileIncident | null>(null);
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
    mutationFn: (input: { incidentId: string; action: "claim" | "assign" | "unassign" | "acknowledge" | "resolve"; targetUserId?: string }) =>
      commandMobileIncident({ orgId: organization!.id, ...input }),
    onSuccess: async () => {
      setAssigningIncident(null);
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
  const commentMutation = useMutation({
    mutationFn: (input: { incidentId: string; requestId: string; body: string; parentId?: string | null }) =>
      addMobileIncidentComment({ orgId: organization!.id, ...input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mobile-incidents", organization?.id] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Comment not posted", error.message),
  });
  const reactionMutation = useMutation({
    mutationFn: (input: { commentId: string; emoji: MobileIncidentReactionEmoji; active: boolean }) =>
      setMobileIncidentCommentReaction({ orgId: organization!.id, ...input }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["mobile-incidents", organization?.id] });
    },
    onError: (error) => Alert.alert("Reaction not saved", error.message),
  });
  const openCount = query.data?.incidents.filter((incident) => incident.status === "open").length ?? 0;
  const currentUserId = bootstrap?.identity.userId;
  const canAssignOthers = query.data?.canAssignResponders ?? false;
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
            <View style={styles.summaryRow}>
              <View style={styles.summary}><AlertTriangle color={openCount ? colors.red : colors.green} size={20} /><Text style={styles.summaryValue}>{openCount}</Text><Text style={styles.summaryText}>open {openCount === 1 ? "incident" : "incidents"}</Text></View>
              {query.data?.historyEnabled ? <Pressable accessibilityRole="button" onPress={() => router.push("/incidents-history")} style={styles.historyButton}><Archive color={colors.textMuted} size={15} /><Text style={styles.historyButtonText}>Full history</Text></Pressable> : null}
            </View>
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
          const incidentComments = query.data?.comments.filter((comment) => comment.incidentId === incident.id) ?? [];
          return (
            <View style={[styles.card, open && incident.severity === "high" && styles.cardHigh]}>
              <View style={styles.cardHeader}>
                {open ? <CircleDot color={incident.severity === "high" ? colors.red : colors.amber} size={16} /> : <CheckCircle2 color={colors.green} size={16} />}
                <Text style={styles.category}>{incident.category}</Text>
                <Text style={[styles.severity, incident.severity === "high" && styles.severityHigh]}>{incident.severity}</Text>
                <Text style={styles.date}>{incident.serviceDate}</Text>
              </View>
              <Text style={styles.description}>{incident.description}</Text>
              <View style={styles.owner}>
                <UserRound color={colors.textFaint} size={13} />
                <Text style={styles.ownerText}>{incident.assignedName || `Reported by ${incident.reportedBy}`}</Text>
                <Text style={styles.status}>{incident.status}</Text>
              </View>
              {incident.resolvedBy ? (
                <Text style={styles.timeline}>Resolved by {incident.resolvedBy}{incident.resolvedAt ? ` · ${new Date(incident.resolvedAt).toLocaleString()}` : ""}</Text>
              ) : incident.acknowledgedAt ? (
                <Text style={styles.timeline}>Acknowledged · {new Date(incident.acknowledgedAt).toLocaleString()}</Text>
              ) : incident.assignedName ? <Text style={styles.timeline}>Awaiting acknowledgement</Text> : null}
              <IncidentDiscussion
                comments={incidentComments}
                currentUserId={currentUserId}
                enabled={query.data?.discussionEnabled ?? false}
                incident={incident}
                pending={commentMutation.isPending || reactionMutation.isPending}
                reactions={query.data?.reactions ?? []}
                onComment={async (input) => { await commentMutation.mutateAsync(input); }}
                onReaction={async (input) => { await reactionMutation.mutateAsync(input); }}
              />
              <View style={styles.cardActions}>
                {query.data?.canManage && open && !incident.assignedTo ? <Pressable accessibilityRole="button" onPress={() => commandMutation.mutate({ incidentId: incident.id, action: "claim" })} style={styles.actionButton}><Hand color={colors.amberText} size={14} /><Text style={styles.actionText}>Claim</Text></Pressable> : null}
                {canAssignOthers && open ? <Pressable accessibilityRole="button" onPress={() => setAssigningIncident(incident)} style={styles.actionButton}><UsersRound color={colors.amberText} size={14} /><Text style={styles.actionText}>{incident.assignedTo ? "Reassign" : "Assign"}</Text></Pressable> : null}
                {query.data?.canManage && open && assignedToMe && !incident.acknowledgedAt ? <Pressable accessibilityRole="button" onPress={() => commandMutation.mutate({ incidentId: incident.id, action: "acknowledge" })} style={styles.actionButton}><Eye color={colors.amberText} size={14} /><Text style={styles.actionText}>Acknowledge</Text></Pressable> : null}
                {query.data?.canManage && open ? <Pressable accessibilityRole="button" onPress={() => confirmResolve(incident)} style={styles.actionButton}><CheckCircle2 color={colors.green} size={14} /><Text style={styles.actionText}>Resolve</Text></Pressable> : null}
                {query.data?.canManage ? <Pressable accessibilityLabel={`Edit ${incident.category} incident`} onPress={() => startEdit(incident)} style={styles.iconButton}><Pencil color={colors.textMuted} size={15} /></Pressable> : null}
                {query.data?.canManage ? <Pressable accessibilityLabel={`Delete ${incident.category} incident`} onPress={() => confirmRemove(incident)} style={styles.iconButton}><Trash2 color={colors.red} size={15} /></Pressable> : null}
              </View>
            </View>
          );
        }}
        windowSize={7}
      />
      <Modal animationType="slide" onRequestClose={() => setAssigningIncident(null)} transparent visible={Boolean(assigningIncident)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={styles.modalHeading}>
                <Text style={styles.modalTitle}>Assign responder</Text>
                <Text style={styles.modalSubtitle}>Only people with incident management access appear here.</Text>
              </View>
              <Pressable accessibilityLabel="Close responder picker" onPress={() => setAssigningIncident(null)} style={styles.iconButton}>
                <X color={colors.textMuted} size={19} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.responderList}>
              {assigningIncident?.assignedTo ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={commandMutation.isPending}
                  onPress={() => commandMutation.mutate({ incidentId: assigningIncident.id, action: "unassign" })}
                  style={[styles.responderChoice, styles.unassignChoice]}
                >
                  <Text style={styles.responderName}>Return to unassigned queue</Text>
                  <Text style={styles.responderRole}>Remove the current owner</Text>
                </Pressable>
              ) : null}
              {query.data?.responders.map((responder) => {
                const selected = responder.userId === assigningIncident?.assignedTo;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: commandMutation.isPending || selected, selected }}
                    key={responder.userId}
                    disabled={commandMutation.isPending || selected}
                    onPress={() => assigningIncident && commandMutation.mutate({ incidentId: assigningIncident.id, action: "assign", targetUserId: responder.userId })}
                    style={[styles.responderChoice, selected && styles.responderChoiceActive]}
                  >
                    <Text style={styles.responderName}>{responder.name}</Text>
                    <Text style={styles.responderRole}>{responder.role}{selected ? " · Current owner" : ""}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Page>
  );
}

function IncidentDiscussion({
  comments,
  currentUserId,
  enabled,
  incident,
  pending,
  reactions,
  onComment,
  onReaction,
}: {
  comments: MobileIncidentComment[];
  currentUserId?: string;
  enabled: boolean;
  incident: MobileIncident;
  pending: boolean;
  reactions: MobileIncidentReaction[];
  onComment: (input: { incidentId: string; requestId: string; body: string; parentId?: string | null }) => Promise<void>;
  onReaction: (input: { commentId: string; emoji: MobileIncidentReactionEmoji; active: boolean }) => Promise<void>;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  if (!enabled) return null;
  const roots = comments.filter((comment) => !comment.parentId);

  async function submitComment() {
    const body = draft.trim();
    if (!body || pending) return;
    try {
      await onComment({
        incidentId: incident.id,
        requestId: createLocalRequestId(),
        body,
        parentId: replyTo,
      });
      setDraft("");
      setReplyTo(null);
    } catch {
      // The parent mutation presents the actionable error.
    }
  }

  function renderComment(comment: MobileIncidentComment, reply = false) {
    const commentReactions = reactions.filter((reaction) => reaction.targetId === comment.id);
    return (
      <View key={comment.id} style={[styles.comment, reply && styles.commentReply]}>
        <View style={styles.commentHeader}>
          <Text style={styles.commentAuthor}>{comment.authorName}</Text>
          <Text style={styles.commentTime}>{new Date(comment.createdAt).toLocaleString()}</Text>
        </View>
        <Text style={styles.commentBody}>{comment.body}</Text>
        <View style={styles.reactionRow}>
          {reactionEmojis.map((emoji) => {
            const emojiReactions = commentReactions.filter((reaction) => reaction.emoji === emoji);
            if (emojiReactions.length === 0) return null;
            const active = emojiReactions.some((reaction) => reaction.userId === currentUserId);
            return (
              <Pressable
                accessibilityLabel={`${active ? "Remove" : "Add"} ${emoji} reaction`}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: pending }}
                disabled={pending}
                key={emoji}
                onPress={() => void onReaction({ commentId: comment.id, emoji, active: !active }).catch(() => undefined)}
                style={[styles.reaction, active && styles.reactionActive]}
              >
                <Text style={styles.reactionText}>{emoji} {emojiReactions.length}</Text>
              </Pressable>
            );
          })}
          <Pressable
            accessibilityLabel="Add reaction"
            accessibilityRole="button"
            onPress={() => setReactionPickerFor((current) => current === comment.id ? null : comment.id)}
            style={styles.reactionPickerButton}
          >
            <MessageCirclePlus color={colors.textMuted} size={15} />
          </Pressable>
          {!reply ? (
            <Pressable accessibilityRole="button" onPress={() => { setReplyTo(comment.id); setOpen(true); }} style={styles.replyButton}>
              <Text style={styles.replyText}>Reply</Text>
            </Pressable>
          ) : null}
        </View>
        {reactionPickerFor === comment.id ? (
          <View style={styles.reactionPicker}>
            {reactionEmojis.map((emoji) => {
              const active = commentReactions.some((reaction) => reaction.emoji === emoji && reaction.userId === currentUserId);
              return (
                <Pressable
                  accessibilityLabel={`${active ? "Remove" : "Add"} ${emoji} reaction`}
                  accessibilityRole="button"
                  disabled={pending}
                  key={emoji}
                  onPress={() => {
                    setReactionPickerFor(null);
                    void onReaction({ commentId: comment.id, emoji, active: !active }).catch(() => undefined);
                  }}
                  style={[styles.reactionPickerChoice, active && styles.reactionActive]}
                >
                  <Text style={styles.reactionPickerEmoji}>{emoji}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.discussion}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((current) => !current)} style={styles.discussionToggle}>
        <MessageCircle color={colors.textMuted} size={15} />
        <Text style={styles.discussionToggleText}>{comments.length} {comments.length === 1 ? "comment" : "comments"}{incident.status === "resolved" ? " · resolution notes" : ""}</Text>
      </Pressable>
      {open ? (
        <View style={styles.discussionBody}>
          {roots.map((comment) => (
            <View key={comment.id} style={styles.thread}>
              {renderComment(comment)}
              {comments.filter((reply) => reply.parentId === comment.id).map((reply) => renderComment(reply, true))}
            </View>
          ))}
          {replyTo ? (
            <View style={styles.replyingBanner}>
              <Text style={styles.replyingText}>Replying in thread</Text>
              <Pressable accessibilityRole="button" onPress={() => setReplyTo(null)}><Text style={styles.cancelText}>Cancel</Text></Pressable>
            </View>
          ) : null}
          <View style={styles.commentComposer}>
            <TextInput
              accessibilityLabel={replyTo ? "Write a reply" : "Write an incident update"}
              maxLength={2000}
              multiline
              onChangeText={setDraft}
              placeholder={incident.status === "resolved" ? "Add a resolution note or follow-up…" : replyTo ? "Write a reply…" : "Add an update…"}
              placeholderTextColor={colors.textFaint}
              style={styles.commentInput}
              value={draft}
            />
            <Pressable
              accessibilityLabel="Post comment"
              accessibilityRole="button"
              accessibilityState={{ busy: pending, disabled: pending || !draft.trim() }}
              disabled={pending || !draft.trim()}
              onPress={() => void submitComment()}
              style={styles.sendButton}
            >
              {pending ? <ActivityIndicator color={colors.black} size="small" /> : <Send color={colors.black} size={17} />}
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  addButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amber },
  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  summary: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryValue: { color: colors.text, fontFamily, fontSize: 22, fontWeight: "900" },
  summaryText: { color: colors.textMuted, fontFamily, fontSize: 13 },
  historyButton: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 10 },
  historyButtonText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "800" },
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
  discussion: { gap: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 9 },
  discussionToggle: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 7 },
  discussionToggleText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "700" },
  discussionBody: { gap: 10 },
  thread: { gap: 7 },
  comment: { gap: 6, borderRadius: radii.small, backgroundColor: colors.panel, padding: 10 },
  commentReply: { marginLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.border },
  commentHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  commentAuthor: { color: colors.text, fontFamily, fontSize: 10, fontWeight: "800" },
  commentTime: { marginLeft: "auto", color: colors.textFaint, fontFamily, fontSize: 8 },
  commentBody: { color: colors.text, fontFamily, fontSize: 12, lineHeight: 18 },
  reactionRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  reaction: { minHeight: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8 },
  reactionActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  reactionText: { color: colors.textMuted, fontFamily, fontSize: 10 },
  reactionPickerButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  replyButton: { minHeight: 36, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  replyText: { color: colors.amberText, fontFamily, fontSize: 10, fontWeight: "800" },
  reactionPicker: { flexDirection: "row", gap: 5, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: 6 },
  reactionPickerChoice: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 9 },
  reactionPickerEmoji: { fontSize: 18 },
  replyingBanner: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: radii.small, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, paddingHorizontal: 10 },
  replyingText: { color: colors.textMuted, fontFamily, fontSize: 10 },
  commentComposer: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  commentInput: { minHeight: 64, maxHeight: 130, flex: 1, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 12, lineHeight: 18, padding: 10, textAlignVertical: "top" },
  sendButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: colors.amber },
  cardActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: 9 },
  actionButton: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 10 },
  actionText: { color: colors.text, fontFamily, fontSize: 9, fontWeight: "900" },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 9, backgroundColor: colors.panel },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay, paddingTop: spacing.xlarge },
  modalCard: { maxHeight: "82%", gap: spacing.medium, borderTopLeftRadius: radii.large, borderTopRightRadius: radii.large, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.medium, paddingBottom: spacing.xlarge },
  modalHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  modalHeading: { flex: 1, gap: 4 },
  modalTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  responderList: { gap: 8, paddingBottom: spacing.small },
  responderChoice: { minHeight: 58, justifyContent: "center", gap: 3, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 14, paddingVertical: 10 },
  responderChoiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  unassignChoice: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  responderName: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  responderRole: { color: colors.textMuted, fontFamily, fontSize: 10, textTransform: "capitalize" },
  error: { color: colors.red, fontFamily, fontSize: 13 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, textAlign: "center" },
}));
