import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Mail from "lucide-react-native/icons/mail";
import Send from "lucide-react-native/icons/send";
import Shield from "lucide-react-native/icons/shield";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserPlus from "lucide-react-native/icons/user-plus";
import UserRound from "lucide-react-native/icons/user-round";
import X from "lucide-react-native/icons/x";
import { Redirect } from "expo-router";
import * as Haptics from "@/lib/haptics";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import {
  cancelMobileTeamInvitation,
  getMobileTeamMembers,
  inviteMobileTeamMember,
  removeMobileTeamMember,
  resolveMobileAvatarUrl,
  updateMobileTeamMemberRole,
  type MobileOrganizationMember,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const roleDetails: Record<string, { label: string; description: string }> = {
  owner: { label: "Owner", description: "Full access, billing, and organization ownership" },
  admin: { label: "Admin", description: "Full system access except organization deletion" },
  td: { label: "Technical Director", description: "Admin-level technical leadership" },
  cd: { label: "Creative Director", description: "Admin-level creative leadership" },
  pd: { label: "Production Director", description: "Admin-level production leadership" },
  pm: { label: "Production Manager", description: "Production planning and show control" },
  tm: { label: "Tech Manager", description: "Technical systems and device operation" },
  sm: { label: "Stage Manager", description: "Stage, show, and rundown control" },
  stageManager: { label: "Stage Manager", description: "Stage, show, and rundown control" },
  member: { label: "Member", description: "Limited operator access" },
};

function roleLabel(role: string) {
  return roleDetails[role]?.label ?? role;
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function TeamMembersScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [editingMember, setEditingMember] = useState<MobileOrganizationMember | null>(null);
  const queryKey = ["mobile-team-members", organization?.id];
  const query = useQuery({
    queryKey,
    queryFn: () => getMobileTeamMembers(organization!.id),
    enabled: Boolean(organization?.id),
    refetchInterval: 15_000,
  });
  const memberById = useMemo(
    () => new Map(query.data?.members.map((member) => [member.id, member]) ?? []),
    [query.data?.members],
  );

  const inviteMutation = useMutation({
    mutationFn: () => inviteMobileTeamMember({ orgId: organization!.id, email, role: inviteRole }),
    onSuccess: async (invitation) => {
      setInviteOpen(false);
      setEmail("");
      await queryClient.invalidateQueries({ queryKey });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Invitation sent", `An invitation was sent to ${invitation.email}.`, [
        { text: "Done" },
        {
          text: "Share link",
          onPress: () => void Share.share({
            message: `Join ${organization?.name ?? "our team"} on ShowPilot: ${SHOWPILOT_URL}/invite/${invitation.id}`,
          }),
        },
      ]);
    },
    onError: (error) => Alert.alert("Invitation not sent", error.message),
  });
  const cancelMutation = useMutation({
    mutationFn: (invitationId: string) => cancelMobileTeamInvitation({ orgId: organization!.id, invitationId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Invitation not cancelled", error.message),
  });
  const roleMutation = useMutation({
    mutationFn: (input: { memberId: string; role: string }) => updateMobileTeamMemberRole({
      orgId: organization!.id,
      ...input,
    }),
    onSuccess: async () => {
      setEditingMember(null);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Role not changed", error.message),
  });
  const removeMutation = useMutation({
    mutationFn: (memberId: string) => removeMobileTeamMember({ orgId: organization!.id, memberId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap"] });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Member not removed", error.message),
  });

  if (organizationPending) return <LoadingView label="Opening team members…" />;
  if (!organization) return <Redirect href="/organizations" />;

  function confirmCancel(invitationId: string, invitationEmail: string) {
    Alert.alert("Cancel invitation?", `${invitationEmail} will no longer be able to use this invite.`, [
      { text: "Keep invitation", style: "cancel" },
      { text: "Cancel invite", style: "destructive", onPress: () => cancelMutation.mutate(invitationId) },
    ]);
  }

  function confirmRemove(memberId: string) {
    const member = memberById.get(memberId);
    Alert.alert(
      "Remove member?",
      `${member?.user.name ?? "This member"} will lose access to this organization and its data.`,
      [
        { text: "Keep member", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => removeMutation.mutate(memberId) },
      ],
    );
  }

  const pendingCount = query.data?.invitations.length ?? 0;

  return (
    <Page
      backTo="/(app)/operations"
      backLabel="Back to operations"
      eyebrow="TEAM CONTROL"
      title="Members"
      scroll={false}
      action={(
        <Pressable accessibilityRole="button" onPress={() => setInviteOpen(true)} style={styles.inviteButton}>
          <UserPlus color={colors.black} size={17} />
          <Text style={styles.inviteButtonText}>Invite</Text>
        </Pressable>
      )}
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={query.data?.members ?? []}
        initialNumToRender={12}
        keyExtractor={(member) => member.id}
        ListHeaderComponent={(
          <View style={styles.headerContent}>
            {query.isPending ? <ActivityIndicator color={colors.amberText} size="large" /> : null}
            {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}
            <View style={styles.summaryCard}>
              <Shield color={colors.blue} size={21} />
              <View style={styles.summaryCopy}>
                <Text style={styles.summaryTitle}>Organization membership</Text>
                <Text style={styles.summaryText}>Invite sign-in users, assign their base role, or remove their workspace access.</Text>
              </View>
            </View>
            {pendingCount > 0 ? (
              <View style={styles.pendingSection}>
                <View style={styles.sectionHeading}>
                  <Text style={styles.sectionTitle}>PENDING INVITATIONS</Text>
                  <Text style={styles.sectionCount}>{pendingCount}</Text>
                </View>
                {query.data?.invitations.map((invitation) => (
                  <View key={invitation.id} style={styles.invitationCard}>
                    <View style={styles.iconCircle}><Mail color={colors.amberText} size={17} /></View>
                    <View style={styles.memberCopy}>
                      <Text numberOfLines={1} style={styles.memberName}>{invitation.email}</Text>
                      <Text style={styles.memberMeta}>{roleLabel(invitation.role ?? "member")} · Expires {formatDate(invitation.expiresAt)}</Text>
                    </View>
                    <Pressable
                      accessibilityLabel={`Cancel invitation for ${invitation.email}`}
                      disabled={cancelMutation.isPending}
                      hitSlop={8}
                      onPress={() => confirmCancel(invitation.id, invitation.email)}
                      style={styles.iconButton}
                    >
                      <X color={colors.red} size={18} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>MEMBERS</Text>
              <Text style={styles.sectionCount}>{query.data?.members.length ?? 0}</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={query.data && !query.isPending ? (
          <View style={styles.emptyCard}>
            <UserRound color={colors.textFaint} size={25} />
            <Text style={styles.emptyTitle}>No members found</Text>
            <Text style={styles.emptyText}>Invite the people who need to sign in to this workspace.</Text>
          </View>
        ) : null}
        maxToRenderPerBatch={12}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: member }) => {
          const avatar = resolveMobileAvatarUrl(member.user.image);
          const isOwner = member.role === "owner";
          return (
            <View style={styles.memberCard}>
              {avatar ? <Image source={{ uri: avatar }} style={styles.avatar} /> : (
                <View style={styles.avatarFallback}><Text style={styles.avatarText}>{member.user.name.charAt(0).toUpperCase()}</Text></View>
              )}
              <View style={styles.memberCopy}>
                <Text numberOfLines={1} style={styles.memberName}>{member.user.name}</Text>
                <Text numberOfLines={1} style={styles.memberMeta}>{member.user.email}</Text>
              </View>
              <View style={styles.memberActions}>
                <Pressable
                  accessibilityLabel={`Change role for ${member.user.name}`}
                  disabled={isOwner}
                  onPress={() => setEditingMember(member)}
                  style={[styles.roleBadge, isOwner ? styles.roleBadgeLocked : null]}
                >
                  <Text style={styles.roleText}>{roleLabel(member.role)}</Text>
                </Pressable>
                {!isOwner ? (
                  <Pressable
                    accessibilityLabel={`Remove ${member.user.name}`}
                    disabled={removeMutation.isPending}
                    hitSlop={8}
                    onPress={() => confirmRemove(member.id)}
                    style={styles.iconButton}
                  >
                    <Trash2 color={colors.red} size={17} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        }}
        windowSize={7}
      />

      <Modal animationType="slide" onRequestClose={() => setInviteOpen(false)} transparent visible={inviteOpen}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View><Text style={styles.modalTitle}>Invite a member</Text><Text style={styles.modalSubtitle}>They will receive an email invitation.</Text></View>
              <Pressable accessibilityLabel="Close invitation form" hitSlop={10} onPress={() => setInviteOpen(false)} style={styles.closeButton}><X color={colors.textMuted} size={20} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
              <Text style={styles.label}>EMAIL</Text>
              <TextInput
                accessibilityLabel="Member email"
                autoCapitalize="none"
                autoComplete="email"
                inputMode="email"
                maxLength={254}
                onChangeText={setEmail}
                placeholder="team@example.com"
                placeholderTextColor={colors.textFaint}
                style={styles.input}
                value={email}
              />
              <Text style={styles.label}>ROLE</Text>
              <View style={styles.choices}>
                {(query.data?.assignableRoles ?? []).map((role) => (
                  <Pressable key={role} onPress={() => setInviteRole(role)} style={[styles.choice, inviteRole === role && styles.choiceActive]}>
                    <Text style={[styles.choiceTitle, inviteRole === role && styles.choiceTitleActive]}>{roleLabel(role)}</Text>
                    <Text style={styles.choiceDescription}>{roleDetails[role]?.description ?? "Organization role"}</Text>
                  </Pressable>
                ))}
              </View>
              <AppButton
                label="Send invitation"
                loading={inviteMutation.isPending}
                disabled={!email.trim() || !inviteRole}
                onPress={() => inviteMutation.mutate()}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setEditingMember(null)} transparent visible={Boolean(editingMember)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View><Text style={styles.modalTitle}>Change member role</Text><Text style={styles.modalSubtitle}>{editingMember?.user.name}</Text></View>
              <Pressable accessibilityLabel="Close role form" hitSlop={10} onPress={() => setEditingMember(null)} style={styles.closeButton}><X color={colors.textMuted} size={20} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.form}>
              {(query.data?.assignableRoles ?? []).map((role) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: editingMember?.role === role }}
                  key={role}
                  disabled={roleMutation.isPending}
                  onPress={() => editingMember && roleMutation.mutate({ memberId: editingMember.id, role })}
                  style={[styles.roleChoice, editingMember?.role === role && styles.choiceActive]}
                >
                  <View style={styles.roleChoiceCopy}>
                    <Text style={[styles.choiceTitle, editingMember?.role === role && styles.choiceTitleActive]}>{roleLabel(role)}</Text>
                    <Text style={styles.choiceDescription}>{roleDetails[role]?.description ?? "Organization role"}</Text>
                  </View>
                  {roleMutation.isPending ? <ActivityIndicator color={colors.amberText} /> : <Send color={colors.textFaint} size={16} />}
                </Pressable>
              ))}
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
  inviteButton: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 7, borderRadius: radii.small, backgroundColor: colors.amber, paddingHorizontal: 13 },
  inviteButtonText: { color: colors.black, fontFamily, fontSize: 11, fontWeight: "900" },
  summaryCard: { flexDirection: "row", alignItems: "flex-start", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  summaryCopy: { flex: 1, gap: 4 },
  summaryTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "900" },
  summaryText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  pendingSection: { gap: 8 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2 },
  sectionCount: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  invitationCard: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, padding: 11 },
  iconCircle: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, backgroundColor: colors.panelStrong },
  memberCard: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 11 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.panelStrong },
  avatarFallback: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: colors.amberSoft },
  avatarText: { color: colors.amberText, fontFamily, fontSize: 16, fontWeight: "900" },
  memberCopy: { flex: 1, minWidth: 0, gap: 3 },
  memberName: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  memberMeta: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 14 },
  memberActions: { alignItems: "flex-end", gap: 4 },
  roleBadge: { minHeight: 36, maxWidth: 122, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, paddingHorizontal: 9 },
  roleBadgeLocked: { borderColor: colors.border, backgroundColor: colors.panel },
  roleText: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "900", textAlign: "center" },
  iconButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 11, backgroundColor: colors.panel },
  emptyCard: { alignItems: "center", gap: 8, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.xlarge },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  emptyText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17, textAlign: "center" },
  error: { color: colors.red, fontFamily, fontSize: 12, textAlign: "center" },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalCard: { maxHeight: "91%", borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingTop: spacing.medium },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: spacing.large, paddingBottom: spacing.medium },
  modalTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "900" },
  modalSubtitle: { color: colors.textMuted, fontFamily, fontSize: 11, marginTop: 3 },
  closeButton: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.panel },
  form: { gap: 11, paddingHorizontal: spacing.large, paddingBottom: spacing.xlarge },
  label: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.2, marginTop: 4 },
  input: { minHeight: 50, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 13, paddingHorizontal: 12 },
  choices: { gap: 7 },
  choice: { minHeight: 55, justifyContent: "center", gap: 3, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 12, paddingVertical: 8 },
  choiceActive: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  choiceTitle: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "900" },
  choiceTitleActive: { color: colors.amberText },
  choiceDescription: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 14 },
  roleChoice: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12 },
  roleChoiceCopy: { flex: 1, gap: 3 },
}));
