import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/providers/workspace-provider";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import Check from "lucide-react-native/icons/check";
import Clock3 from "lucide-react-native/icons/clock-3";
import KeyRound from "lucide-react-native/icons/key-round";
import ShieldCheck from "lucide-react-native/icons/shield-check";
import UserRound from "lucide-react-native/icons/user-round";
import X from "lucide-react-native/icons/x";
import { Redirect, useNavigation } from "expo-router";
import { createLocalRequestUuid } from "@/lib/request-id";
import { accessCommandSchema, accessMutationOptions } from "@/lib/access-recovery";
import * as Haptics from "@/lib/haptics";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import {
  getMobileTeamAccess,
  grantMobileTeamAccess,
  resolveMobileAvatarUrl,
  revokeMobileTeamAccess,
  retryMobileAccessNotice,
  type MobileTeamAccessGrant,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const roleLabels: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  td: "Technical Director",
  cd: "Creative Director",
  pd: "Production Director",
  pm: "Production Manager",
  tm: "Tech Manager",
  sm: "Stage Manager",
  stageManager: "Stage Manager",
  member: "Member",
};

function formatDate(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function weekLabel(start: string, endExclusive: string) {
  const end = new Date(`${endExclusive}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${formatDate(start)} to ${formatDate(end.toISOString().slice(0, 10))}`;
}

function grantEndLabel(endExclusive: string) {
  const end = new Date(`${endExclusive}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return formatDate(end.toISOString().slice(0, 10));
}

export default function TeamScreen() {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending) return <LoadingView label="Opening team access…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return <AccessWorkspace key={`${organization.id}:${session.user.id}`} orgId={organization.id} userId={session.user.id} />;
}
function AccessWorkspace({ orgId, userId }: { orgId: string; userId: string }) {
  const workspaceTerms = useWorkspaceTerms();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [grantOpen, setGrantOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [duration, setDuration] = useState<"this-week" | "until-revoked">("this-week");
  const [reason, setReason] = useState("");
  const [hasDraft, setHasDraft] = useState(false);
  const [reviewedWeek, setReviewedWeek] = useState<{ weekStart: string; weekEndExclusive: string } | null>(null);
  const [notice, setNotice] = useState("");
  const navigation = useNavigation();
  const allowLeave = useRef(false);
  const queryKey = ["mobile-team-access", orgId, userId];
  const pollingInterval = useScreenPollingInterval(15_000);
  const query = useQuery({
    queryKey,
    queryFn: () => getMobileTeamAccess(orgId),
    networkMode: "always",
    refetchInterval: pollingInterval,
  });
  const eligibleMembers = useMemo(
    () => query.data?.members.filter((member) => member.userId !== query.data.currentUserId) ?? [],
    [query.data],
  );
  const capabilityById = useMemo(
    () => new Map(query.data?.capabilities.map((capability) => [capability.id, capability]) ?? []),
    [query.data?.capabilities],
  );
  const memberById = useMemo(
    () => new Map(query.data?.members.map((member) => [member.userId, member]) ?? []),
    [query.data?.members],
  );

  const commandKey = ["access-command", orgId, userId];
  const history = useMutationState({ filters: { mutationKey: commandKey, exact: true }, select: mutation => ({ status: mutation.state.status, command: accessCommandSchema.safeParse(mutation.state.variables), error: mutation.state.error }) });
  const latest = history.at(-1);
  const unfinished = latest && (latest.status === "pending" || latest.status === "error") ? latest : null;
  const locked = !!unfinished || !query.data || !!query.error;
  const mutation = useMutation(accessMutationOptions({
    key: commandKey, client: queryClient,
    execute: command => command.kind === "grant" ? grantMobileTeamAccess(command) : command.kind === "revoke" ? revokeMobileTeamAccess(command) : retryMobileAccessNotice(command),
    confirmed: (result, command) => {
      if (command.kind === "grant") { setGrantOpen(false); setHasDraft(false); setReason(""); }
      setNotice(`${result.kind === "revoke" ? "Access revoked." : result.state === "active" ? "Access granted." : "The saved grant is no longer active. Retrying did not restore it."} ${result.notification === "pending" ? "Member notification pending. Retry it below." : result.notification === "created" ? "Member notification created." : "Outdated notification skipped."}`);
      void queryClient.invalidateQueries({ queryKey });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
  }));
  useEffect(() => navigation.addListener("beforeRemove", event => {
    if (allowLeave.current || !hasDraft) return;
    event.preventDefault();
    Alert.alert("Leave access?", "Your unsaved draft will be discarded. Unconfirmed requests keep their exact retry controls when you return.", [
      { text: "Stay", style: "cancel" }, { text: "Leave", style: "destructive", onPress: () => { allowLeave.current = true; navigation.dispatch(event.data.action); } },
    ]);
  }), [navigation, hasDraft]);
  function review() {
    Alert.alert("Review stored access?", "The request may already have saved. Refresh before discarding its exact retry. A request still in progress may finish later.", [
      { text: "Keep retry", style: "cancel" }, { text: "Review access", onPress: () => { void query.refetch().then(result => {
        if (result.isError) return;
        const cache = queryClient.getMutationCache();
        for (const failed of cache.findAll({ mutationKey: commandKey, exact: true, status: "error" })) cache.remove(failed);
      }); } },
    ]);
  }
  function save() {
    if (locked) return;
    const parsed = accessCommandSchema.safeParse({ kind: "grant", orgId, requestId: createLocalRequestUuid(), userId: targetUserId, capability: capabilityId, duration, reason, expectedWeekStart: reviewedWeek?.weekStart });
    if (!parsed.success) { Alert.alert("Review access", "Choose a member, capability and duty week before saving."); return; }
    mutation.mutate(parsed.data);
  }
  function discard() {
    if (locked) return;
    Alert.alert("Discard access draft?", "Your unsaved choices will be removed.", [ { text: "Keep draft", style: "cancel" }, { text: "Discard", style: "destructive", onPress: () => { setGrantOpen(false); setHasDraft(false); setReason(""); } } ]);
  }

  function openGrantForm() {
    if (locked) return;
    if (!hasDraft) {
      setTargetUserId(eligibleMembers[0]?.userId ?? "");
      setCapabilityId(query.data?.capabilities[0]?.id ?? "");
      setDuration("this-week"); setReason("");
      if (query.data) setReviewedWeek(query.data.authority);
      setHasDraft(true);
    }
    setGrantOpen(true);
  }

  function confirmRevoke(grant: MobileTeamAccessGrant) {
    if (locked || !query.data) return;
    const command = accessCommandSchema.parse({ kind: "revoke", orgId, grantId: grant.id, requestId: createLocalRequestUuid(), expectedWeekStart: query.data.authority.weekStart });
    const member = memberById.get(grant.userId);
    const capability = capabilityById.get(grant.capability);
    Alert.alert(
      "Revoke access?",
      `${member?.user.name ?? "This member"} will lose ${capability?.label ?? grant.capability} access immediately.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Revoke", style: "destructive", onPress: () => mutation.mutate(command) },
      ],
    );
  }

  const authority = query.data?.authority;
  const canManage = authority?.canManage === true;
  const selectedCapability = capabilityById.get(capabilityId);

  return (
    <Page
      backTo="/(app)/operations"
      backLabel="Back to operations"
      eyebrow="TEAM CONTROL"
      title="Access grants"
      scroll={false}
      action={canManage ? (
        <Pressable accessibilityRole="button" disabled={locked} onPress={openGrantForm} style={styles.grantButton}>
          <KeyRound color={colors.black} size={17} />
          <Text style={styles.grantButtonText}>{hasDraft ? "Resume draft" : "Grant"}</Text>
        </Pressable>
      ) : null}
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={query.data?.grants ?? []}
        initialNumToRender={10}
        keyExtractor={(grant) => grant.id}
        ListHeaderComponent={
          <View style={styles.headerContent}>
            {query.isPending ? (
              <ActivityIndicator color={colors.amberText} size="large" />
            ) : null}
            {query.error ? (
              <View><Text accessibilityRole="alert" style={styles.error}>{query.error.message}</Text><AppButton label="Retry access refresh" variant="secondary" onPress={() => void query.refetch()} /></View>
            ) : null}
            {unfinished && <View><Text accessibilityRole="alert" style={styles.error}>{unfinished.status === "pending" ? "Waiting for access confirmation…" : `Access request unconfirmed. ${unfinished.error instanceof Error ? unfinished.error.message : "Retry the same request."}`}</Text>
              {unfinished.status === "error" && <><AppButton label="Retry access change" onPress={() => { if (unfinished.command.success) mutation.mutate(unfinished.command.data); }} /><AppButton label="Review stored access" variant="secondary" onPress={review} /></>}
            </View>}
            {!!notice && <Text accessibilityRole="alert" style={styles.authorityText}>{notice}</Text>}
            {query.data?.notices.map(item => <View key={item.requestId}><Text style={styles.authorityText}>{item.message}</Text><AppButton label="Retry member notification" variant="secondary" disabled={locked} onPress={() => mutation.mutate({ kind: "notice", orgId, requestId: item.requestId })} /></View>)}
            {authority ? (
              <View style={[styles.authorityCard, canManage ? styles.authorityCardActive : null]}>
                <View style={styles.authorityIcon}>
                  {authority.kind === "permanent" ? (
                    <ShieldCheck color={colors.blue} size={20} />
                  ) : (
                    <Clock3 color={canManage ? colors.amberText : colors.textFaint} size={20} />
                  )}
                </View>
                <View style={styles.authorityCopy}>
                  <Text style={styles.authorityTitle}>
                    {authority.kind === "permanent"
                      ? "Permanent access authority"
                      : authority.kind === "on-duty-tm" ? "On-duty TM authority" : "No grant authority"}
                  </Text>
                  <Text style={styles.authorityText}>
                    {authority.kind === "permanent"
                      ? "You can grant weekly or ongoing operational access and revoke active grants."
                      : authority.kind === "on-duty-tm"
                        ? `You can manage access for this duty week, ${weekLabel(authority.weekStart, authority.weekEndExclusive)}.`
                        : "Owners, Admins, and the on-duty Tech Manager can manage temporary access."}
                  </Text>
                </View>
              </View>
            ) : null}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>ACTIVE GRANTS</Text>
              <Text style={styles.sectionCount}>{query.data?.grants.length ?? 0}</Text>
            </View>
          </View>
        }
        ListEmptyComponent={query.data && !query.isPending ? (
          <View style={styles.emptyCard}>
            <KeyRound color={colors.textFaint} size={25} />
            <Text style={styles.emptyTitle}>No custom access is active</Text>
            <Text style={styles.emptyText}>Members are using only the permissions included with their normal roles.</Text>
          </View>
        ) : null}
        maxToRenderPerBatch={10}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: grant }) => {
          const member = memberById.get(grant.userId);
          const capability = capabilityById.get(grant.capability);
          const avatar = resolveMobileAvatarUrl(member?.user.image);
          return (
            <View style={styles.grantCard}>
              <View style={styles.memberRow}>
                {avatar ? (
                  <Image source={{ uri: avatar }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatarFallback}><UserRound color={colors.amberText} size={18} /></View>
                )}
                <View style={styles.memberCopy}>
                  <Text numberOfLines={1} style={styles.memberName}>{member?.user.name ?? "Organization member"}</Text>
                  <Text numberOfLines={1} style={styles.memberMeta}>{member?.user.email ?? ""} · {roleLabels[member?.role ?? ""] ?? member?.role ?? "Member"}</Text>
                </View>
              </View>
              <View style={styles.capabilityRow}>
                <Check color={colors.green} size={15} />
                <Text style={styles.capabilityName}>{capability?.label ?? grant.capability}</Text>
              </View>
              <Text style={styles.grantMeta}>
                {grant.expiresOn ? `Active through ${grantEndLabel(grant.expiresOn)}` : "Active until revoked"} · Granted by {grant.grantedBy.name}
              </Text>
              {grant.reason ? (
                <Text style={styles.reason}>{grant.reason}</Text>
              ) : null}
              {grant.canRevoke ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={locked}
                  onPress={() => confirmRevoke(grant)}
                  style={styles.revokeButton}
                >
                  <Text style={styles.revokeText}>Revoke access</Text>
                </Pressable>
              ) : null}
            </View>
          );
        }}
        windowSize={7}
      />

      <Modal animationType="slide" onRequestClose={() => setGrantOpen(false)} transparent visible={grantOpen}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View><Text style={styles.modalTitle}>Grant operational access</Text><Text style={styles.modalSubtitle}>The member keeps their normal role.</Text></View>
              <Pressable accessibilityLabel="Close grant form" accessibilityRole="button" hitSlop={10} onPress={() => setGrantOpen(false)} style={styles.closeButton}><X color={colors.textMuted} size={20} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
              {unfinished && <View><Text accessibilityRole="alert" style={styles.error}>An access request is unconfirmed. Close this form to use its retry controls.</Text></View>}
              {reviewedWeek && <Text style={styles.description}>Reviewed duty week: {weekLabel(reviewedWeek.weekStart, reviewedWeek.weekEndExclusive)}</Text>}
              {reviewedWeek && authority?.weekStart !== reviewedWeek.weekStart && <Text accessibilityRole="alert" style={styles.error}>The duty week changed. Discard this draft and review a new grant.</Text>}
              <Text style={styles.label}>MEMBER</Text>
              <View accessibilityRole="radiogroup" style={styles.choices}>
                {eligibleMembers.map((member) => (
                  <Pressable disabled={locked} accessibilityRole="radio" accessibilityState={{ checked: targetUserId === member.userId }} key={member.userId} onPress={() => setTargetUserId(member.userId)} style={[styles.choice, targetUserId === member.userId && styles.choiceActive]}>
                    <Text style={[styles.choiceTitle, targetUserId === member.userId && styles.choiceTitleActive]}>{member.user.name}</Text>
                    <Text style={styles.choiceMeta}>{roleLabels[member.role] ?? member.role}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>CAPABILITY</Text>
              <View accessibilityRole="radiogroup" style={styles.choices}>
                {query.data?.capabilities.map((capability) => (
                  <Pressable disabled={locked} accessibilityRole="radio" accessibilityState={{ checked: capabilityId === capability.id }} key={capability.id} onPress={() => setCapabilityId(capability.id)} style={[styles.choice, capabilityId === capability.id && styles.choiceActive]}>
                    <Text style={[styles.choiceTitle, capabilityId === capability.id && styles.choiceTitleActive]}>{capability.label}</Text>
                  </Pressable>
                ))}
              </View>
              {selectedCapability ? (
                <Text style={styles.description}>{selectedCapability.description}</Text>
              ) : null}

              {authority?.kind === "permanent" ? (
                <>
                  <Text style={styles.label}>DURATION</Text>
                  <View style={styles.durationRow} accessibilityRole="radiogroup">
                    <Pressable disabled={locked} accessibilityRole="radio" accessibilityState={{ checked: duration === "this-week" }} onPress={() => setDuration("this-week")} style={[styles.durationChoice, duration === "this-week" && styles.choiceActive]}><Text style={[styles.choiceTitle, duration === "this-week" && styles.choiceTitleActive]}>This duty week</Text></Pressable>
                    <Pressable disabled={locked} accessibilityRole="radio" accessibilityState={{ checked: duration === "until-revoked" }} onPress={() => setDuration("until-revoked")} style={[styles.durationChoice, duration === "until-revoked" && styles.choiceActive]}><Text style={[styles.choiceTitle, duration === "until-revoked" && styles.choiceTitleActive]}>Until revoked</Text></Pressable>
                  </View>
                </>
              ) : null}

              <Text style={styles.label}>REASON · OPTIONAL</Text>
              <TextInput
                editable={!locked}
                accessibilityLabel="Reason for access grant"
                maxLength={240}
                onChangeText={setReason}
                placeholder={workspaceCopy(
                  "Covering rundown for Sunday service",
                  workspaceTerms,
                )}
                placeholderTextColor={colors.textFaint}
                style={styles.reasonInput}
                value={reason}
              />
              <AppButton label="Grant access" disabled={locked || !targetUserId || !capabilityId} onPress={save} />
              <AppButton label="Discard draft" variant="secondary" disabled={locked} onPress={discard} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 10, paddingBottom: spacing.large },
  headerContent: { gap: spacing.medium, paddingBottom: 2 },
  grantButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 7, borderRadius: radii.small, backgroundColor: colors.amber, paddingHorizontal: 13 },
  grantButtonText: { color: colors.black, fontFamily, fontSize: 12, fontWeight: "900" },
  authorityCard: { flexDirection: "row", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  authorityCardActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  authorityIcon: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.panelStrong },
  authorityCopy: { flex: 1, gap: 5 },
  authorityTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "900" },
  authorityText: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "900", letterSpacing: 1.2 },
  sectionCount: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800" },
  grantCard: { gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  memberRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.panelStrong },
  avatarFallback: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 21, backgroundColor: colors.amberSoft },
  memberCopy: { flex: 1, minWidth: 0, gap: 3 },
  memberName: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  memberMeta: { color: colors.textMuted, fontFamily, fontSize: 12 },
  capabilityRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  capabilityName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  grantMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 15 },
  reason: { color: colors.textMuted, fontFamily, fontSize: 12, fontStyle: "italic", lineHeight: 16 },
  revokeButton: { minHeight: 44, alignItems: "center", justifyContent: "center", alignSelf: "flex-start", borderRadius: radii.small, borderWidth: 1, borderColor: colors.redBorder, paddingHorizontal: 13 },
  revokeText: { color: colors.red, fontFamily, fontSize: 12, fontWeight: "900" },
  emptyCard: { alignItems: "center", gap: 8, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.xlarge },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  emptyText: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17, textAlign: "center" },
  error: { color: colors.red, fontFamily, fontSize: 12, textAlign: "center" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalCard: { maxHeight: "91%", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingTop: spacing.medium },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: spacing.large, paddingBottom: spacing.medium },
  modalTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 12, marginTop: 3 },
  closeButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.panel },
  form: { gap: 11, paddingHorizontal: spacing.large, paddingBottom: spacing.xlarge },
  label: { color: colors.textFaint, fontFamily, fontSize: 12, fontWeight: "900", letterSpacing: 1.2, marginTop: 4 },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: { minHeight: 44, justifyContent: "center", gap: 2, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 11, paddingVertical: 7 },
  choiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  choiceTitle: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800" },
  choiceTitleActive: { color: colors.amberText },
  choiceMeta: { color: colors.textFaint, fontFamily, fontSize: 12 },
  description: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17, borderRadius: radii.small, backgroundColor: colors.panel, padding: 10 },
  durationRow: { flexDirection: "row", gap: 8 },
  durationChoice: { minHeight: 44, flex: 1, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 8 },
  reasonInput: { minHeight: 48, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 13, paddingHorizontal: 12 },
}));
