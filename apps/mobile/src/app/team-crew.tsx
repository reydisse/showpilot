import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Pencil from "lucide-react-native/icons/pencil";
import Search from "lucide-react-native/icons/search";
import Trash2 from "lucide-react-native/icons/trash-2";
import UserPlus from "lucide-react-native/icons/user-plus";
import UserRound from "lucide-react-native/icons/user-round";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/providers/workspace-provider";
import { AppButton } from "@/components/app-button";
import {
  CrewProfileSheet,
  crewPhotoUri,
} from "@/components/crew-profile-sheet";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { getMobileTeamCrew } from "@/lib/mobile-api";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import { useCrewDrafts } from "@/hooks/use-crew-profile";
import {
  crewDraftFromSnapshot,
  newCrewDraft,
  type CrewDraft,
} from "@/lib/crew-recovery";
import {
  createThemedStyles,
  fontFamily,
  radii,
  spacing,
  useAppTheme,
} from "@/theme/tokens";
export default function TeamCrewScreen() {
  const { data: organization, isPending: organizationPending } =
    authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending)
    return <LoadingView label="Opening crew roster…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return (
    <CrewWorkspace
      key={`${organization.id}:${session.user.id}`}
      organization={organization}
      userId={session.user.id}
    />
  );
}
function CrewWorkspace({
  organization,
  userId,
}: {
  organization: { id: string };
  userId: string;
}) {
  const workspaceTerms = useWorkspaceTerms(),
    { colors } = useAppTheme(),
    styles = useStyles();
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<CrewDraft | null>(null);
  const drafts = useCrewDrafts({ orgId: organization.id, userId });
  const pollingInterval = useScreenPollingInterval(15_000);
  const query = useQuery({
    queryKey: ["mobile-team-crew", userId, organization.id],
    networkMode: "always",
    queryFn: () => getMobileTeamCrew(organization.id),
    enabled: Boolean(organization.id),
    refetchInterval: pollingInterval,
  });
  const filteredMembers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (query.data?.members ?? []).filter(
      (member) =>
        !needle ||
        [member.name, member.role, member.memberId, member.email].some(
          (value) => value.toLowerCase().includes(needle),
        ),
    );
  }, [query.data?.members, search]);
  const locked = query.isPending || !!query.error;
  const onlineCount =
    query.data?.members.filter((member) => member.isOnline).length ?? 0;
  return (
    <Page
      backTo="/(app)/operations"
      backLabel="Back to operations"
      eyebrow="TEAM CONTROL"
      title="Crew roster"
      scroll={false}
      action={
        <Pressable
          accessibilityRole="button"
          disabled={locked}
          onPress={() => setEditor(newCrewDraft())}
          style={styles.addButton}
        >
          <UserPlus color={colors.black} size={17} />
          <Text style={styles.addButtonText}>Add</Text>
        </Pressable>
      }
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={filteredMembers}
        initialNumToRender={12}
        keyExtractor={(member) => member.id}
        ListHeaderComponent={
          <View style={styles.headerContent}>
            {drafts.map((draft) => (
              <AppButton
                key={draft.slot}
                label={`Resume crew change: ${draft.fields.name || "New crew member"}`}
                variant="secondary"
                onPress={() => setEditor(draft)}
              />
            ))}
            {query.isPending ? (
              <ActivityIndicator color={colors.amberText} size="large" />
            ) : null}
            {query.error ? (
              <View style={styles.summaryCopy}>
                <Text accessibilityRole="alert" style={styles.error}>
                  {query.error.message}
                </Text>
                <AppButton
                  label="Retry crew roster"
                  loading={query.isFetching}
                  onPress={() => void query.refetch()}
                />
              </View>
            ) : null}
            <View style={styles.summaryCard}>
              <UsersRound color={colors.blue} size={22} />
              <View style={styles.summaryCopy}>
                <Text style={styles.summaryTitle}>
                  {query.data
                    ? `${query.data.members.length} crew · ${onlineCount} checked in`
                    : "Crew roster"}
                </Text>
                <Text style={styles.summaryText}>
                  This production roster drives badges, check-in, assignments,
                  and call-time messages.
                </Text>
              </View>
            </View>
            <View style={styles.searchBox}>
              <Search color={colors.textFaint} size={18} />
              <TextInput
                accessibilityLabel="Search crew roster"
                autoCapitalize="none"
                onChangeText={setSearch}
                placeholder="Search name, role, email, or member ID"
                placeholderTextColor={colors.textFaint}
                style={styles.searchInput}
                value={search}
              />
              {search ? (
                <Pressable
                  accessibilityLabel="Clear crew search"
                  accessibilityRole="button"
                  style={styles.iconButton}
                  onPress={() => setSearch("")}
                >
                  <X color={colors.textFaint} size={17} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>PRODUCTION CREW</Text>
              <Text style={styles.sectionCount}>{filteredMembers.length}</Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          query.data && !query.isPending && !query.error ? (
            <View style={styles.emptyCard}>
              <UserRound color={colors.textFaint} size={25} />
              <Text style={styles.emptyTitle}>
                {search ? "No matching crew" : "No crew members yet"}
              </Text>
              <Text style={styles.emptyText}>
                {search
                  ? "Try another name, role, email, or ID."
                  : workspaceCopy(
                      "Add the people who serve on your production team.",
                      workspaceTerms,
                    )}
              </Text>
            </View>
          ) : null
        }
        maxToRenderPerBatch={12}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: member }) => {
          const photo = crewPhotoUri(member.photoUrl);
          return (
            <View style={styles.memberCard}>
              <View>
                {photo ? (
                  <Image source={{ uri: photo }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatarFallback}>
                    <Text style={styles.avatarText}>
                      {member.name.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
                <View
                  style={[
                    styles.statusDot,
                    member.isOnline
                      ? styles.statusOnline
                      : styles.statusOffline,
                  ]}
                />
              </View>
              <View style={styles.memberCopy}>
                <View style={styles.nameRow}>
                  <Text numberOfLines={1} style={styles.memberName}>
                    {member.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.memberId}>
                    {member.memberId}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.memberRole}>
                  {member.role}
                </Text>
                {member.email ? (
                  <Text numberOfLines={1} style={styles.memberEmail}>
                    {member.email}
                  </Text>
                ) : null}
              </View>
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit ${member.name}`}
                  disabled={locked}
                  onPress={() =>
                    setEditor(crewDraftFromSnapshot("update", member))
                  }
                  style={styles.iconButton}
                >
                  <Pencil color={colors.textMuted} size={17} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${member.name}`}
                  disabled={locked}
                  onPress={() =>
                    setEditor(crewDraftFromSnapshot("delete", member))
                  }
                  style={styles.iconButton}
                >
                  <Trash2 color={colors.red} size={17} />
                </Pressable>
              </View>
            </View>
          );
        }}
        windowSize={7}
      />

      {editor ? (
        <CrewProfileSheet
          key={`${userId}:${organization.id}:${editor.slot}`}
          orgId={organization.id}
          userId={userId}
          initial={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    list: { gap: 10, paddingBottom: spacing.large },
    headerContent: { gap: spacing.medium, paddingBottom: 2 },
    addButton: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      borderRadius: radii.small,
      backgroundColor: colors.amber,
      paddingHorizontal: 13,
    },
    addButtonText: {
      color: colors.black,
      fontFamily,
      fontSize: 11,
      fontWeight: "900",
    },
    summaryCard: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      borderRadius: radii.medium,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.panel,
      padding: spacing.medium,
    },
    summaryCopy: { flex: 1, gap: 4 },
    summaryTitle: {
      color: colors.text,
      fontFamily,
      fontSize: 14,
      fontWeight: "900",
    },
    summaryText: {
      color: colors.textMuted,
      fontFamily,
      fontSize: 11,
      lineHeight: 17,
    },
    searchBox: {
      minHeight: 50,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: radii.medium,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.panel,
      paddingHorizontal: 13,
    },
    searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 13 },
    sectionHeading: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitle: {
      color: colors.textMuted,
      fontFamily,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1.2,
    },
    sectionCount: {
      color: colors.textMuted,
      fontFamily,
      fontSize: 11,
      fontWeight: "800",
    },
    memberCard: {
      minHeight: 82,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      borderRadius: radii.medium,
      borderWidth: 1,
      borderColor: colors.borderSoft,
      backgroundColor: colors.stageRaised,
      padding: 11,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.panelStrong,
    },
    avatarFallback: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 24,
      backgroundColor: colors.amberSoft,
    },
    avatarText: {
      color: colors.amberText,
      fontFamily,
      fontSize: 17,
      fontWeight: "900",
    },
    statusDot: {
      position: "absolute",
      right: 0,
      bottom: 0,
      width: 13,
      height: 13,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: colors.stageRaised,
    },
    statusOnline: { backgroundColor: colors.green },
    statusOffline: { backgroundColor: colors.textFaint },
    memberCopy: { flex: 1, minWidth: 0, gap: 3 },
    nameRow: { alignItems: "flex-start", gap: 4 },
    memberName: {
      flexShrink: 1,
      color: colors.text,
      fontFamily,
      fontSize: 13,
      fontWeight: "800",
    },
    memberId: {
      maxWidth: "100%",
      color: colors.textMuted,
      fontFamily,
      fontSize: 11,
      fontWeight: "800",
      borderRadius: 5,
      backgroundColor: colors.panel,
      paddingHorizontal: 5,
      paddingVertical: 2,
    },
    memberRole: {
      color: colors.amberText,
      fontFamily,
      fontSize: 11,
      fontWeight: "800",
    },
    memberEmail: { color: colors.textMuted, fontFamily, fontSize: 11 },
    actions: { flexDirection: "row", gap: 4 },
    iconButton: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 11,
      backgroundColor: colors.panel,
    },
    emptyCard: {
      alignItems: "center",
      gap: 8,
      borderRadius: radii.medium,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.border,
      padding: spacing.xlarge,
    },
    emptyTitle: {
      color: colors.text,
      fontFamily,
      fontSize: 14,
      fontWeight: "800",
    },
    emptyText: {
      color: colors.textMuted,
      fontFamily,
      fontSize: 11,
      lineHeight: 17,
      textAlign: "center",
    },
    error: { color: colors.red, fontFamily, fontSize: 12, textAlign: "center" },
  }),
);
