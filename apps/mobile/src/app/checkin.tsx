import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle2 from "lucide-react-native/icons/circle-check-big";
import KeyRound from "lucide-react-native/icons/key-round";
import LogIn from "lucide-react-native/icons/log-in";
import LogOut from "lucide-react-native/icons/log-out";
import Search from "lucide-react-native/icons/search";
import UsersRound from "lucide-react-native/icons/users-round";
import X from "lucide-react-native/icons/x";
import { Redirect } from "expo-router";
import * as Haptics from "@/lib/haptics";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import {
  getMobileCheckIn,
  setMobileCheckInStatus,
  type MobileCheckIn,
  type MobileCheckInMember,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type Mode = "code" | "browse";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

export default function CheckInScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const [mode, setMode] = useState<Mode>("code");
  const [code, setCode] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [codeError, setCodeError] = useState("");
  const queryKey = ["mobile-checkin", organization?.id];
  const query = useQuery({
    queryKey,
    queryFn: () => getMobileCheckIn(organization!.id),
    enabled: Boolean(organization?.id),
    refetchInterval: 15_000,
  });
  const members = useMemo(() => query.data?.members ?? [], [query.data?.members]);
  const selectedMember = selectedId ? members.find((member) => member.id === selectedId) ?? null : null;
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return members;
    return members.filter((member) =>
      member.name.toLowerCase().includes(term)
      || member.role.toLowerCase().includes(term)
      || member.memberId.toLowerCase().includes(term));
  }, [members, search]);
  const checkedInCount = members.filter((member) => member.isOnline).length;

  const statusMutation = useMutation({
    mutationFn: ({ member, checkedIn }: { member: MobileCheckInMember; checkedIn: boolean }) =>
      setMobileCheckInStatus({ orgId: organization!.id, memberId: member.id, checkedIn }),
    onSuccess: async ({ member }) => {
      queryClient.setQueryData<MobileCheckIn>(queryKey, (current) => current
        ? { members: current.members.map((candidate) => candidate.id === member.id ? member : candidate) }
        : current);
      setSelectedId(member.id);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (error) => Alert.alert("Check-in not updated", error.message),
  });

  if (organizationPending) return <LoadingView label="Opening crew check-in…" />;
  if (!organization) return <Redirect href="/organizations" />;

  function findCode() {
    const normalized = code.trim().toLowerCase();
    const member = members.find((candidate) => candidate.memberId.trim().toLowerCase() === normalized);
    if (!member) {
      setSelectedId(null);
      setCodeError("No crew member matches that ID.");
      return;
    }
    setCode("");
    setCodeError("");
    setSelectedId(member.id);
  }

  function changeMode(nextMode: Mode) {
    setMode(nextMode);
    setSelectedId(null);
    setCodeError("");
    setCode("");
    setSearch("");
  }

  const header = (
    <View style={styles.headerContent}>
      <View style={styles.modeSwitch} accessibilityRole="radiogroup">
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: mode === "code" }}
          onPress={() => changeMode("code")}
          style={[styles.modeButton, mode === "code" && styles.modeButtonActive]}
        >
          <KeyRound color={mode === "code" ? colors.amberText : colors.textMuted} size={17} />
          <Text style={[styles.modeText, mode === "code" && styles.modeTextActive]}>Use member ID</Text>
        </Pressable>
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: mode === "browse" }}
          onPress={() => changeMode("browse")}
          style={[styles.modeButton, mode === "browse" && styles.modeButtonActive]}
        >
          <UsersRound color={mode === "browse" ? colors.amberText : colors.textMuted} size={17} />
          <Text style={[styles.modeText, mode === "browse" && styles.modeTextActive]}>Browse crew</Text>
        </Pressable>
      </View>

      <View style={styles.summary}>
        <View style={styles.summaryItem}><View style={[styles.dot, styles.dotOnline]} /><Text style={styles.summaryText}>{checkedInCount} checked in</Text></View>
        <View style={styles.summaryItem}><View style={styles.dot} /><Text style={styles.summaryText}>{members.length - checkedInCount} out</Text></View>
      </View>

      {query.isPending ? <ActivityIndicator color={colors.amberText} size="large" /> : null}
      {query.error ? <Text onPress={() => query.refetch()} style={styles.error}>{query.error.message} · Tap to retry</Text> : null}

      {mode === "code" && !query.isPending ? (
        selectedMember ? (
          <View style={[styles.resultCard, selectedMember.isOnline && styles.resultCardOnline]}>
            <MemberIdentity member={selectedMember} />
            <View style={[styles.statePill, selectedMember.isOnline ? styles.statePillOnline : styles.statePillOut]}>
              <CheckCircle2 color={selectedMember.isOnline ? colors.green : colors.textMuted} size={16} />
              <Text style={[styles.stateText, selectedMember.isOnline && styles.stateTextOnline]}>
                {selectedMember.isOnline ? "Checked in" : "Currently out"}
              </Text>
            </View>
            <AppButton
              label={statusMutation.isPending
                ? "Updating…"
                : selectedMember.isOnline ? "Check out" : "Check in"}
              disabled={statusMutation.isPending}
              onPress={() => statusMutation.mutate({ member: selectedMember, checkedIn: !selectedMember.isOnline })}
            />
            <Pressable onPress={() => setSelectedId(null)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Use another ID</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.codeCard}>
            <View style={styles.codeIcon}><KeyRound color={colors.amberText} size={30} /></View>
            <Text style={styles.codeTitle}>Enter a member ID</Text>
            <Text style={styles.codeHelp}>We’ll show the current status before you confirm, preventing accidental double check-ins.</Text>
            <TextInput
              accessibilityLabel="Crew member ID"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={128}
              onChangeText={(value) => { setCode(value.toUpperCase()); setCodeError(""); }}
              onSubmitEditing={findCode}
              placeholder="e.g. TD3917"
              placeholderTextColor={colors.textFaint}
              returnKeyType="search"
              style={styles.codeInput}
              value={code}
            />
            {codeError ? <Text accessibilityRole="alert" style={styles.error}>{codeError}</Text> : null}
            <AppButton label="Find crew member" disabled={!code.trim()} onPress={findCode} />
          </View>
        )
      ) : null}

      {mode === "browse" ? (
        <View style={styles.searchBox}>
          <Search color={colors.textFaint} size={18} />
          <TextInput
            accessibilityLabel="Search crew"
            autoCorrect={false}
            onChangeText={setSearch}
            placeholder="Search name, role, or member ID"
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
            value={search}
          />
          {search ? (
            <Pressable accessibilityLabel="Clear crew search" hitSlop={10} onPress={() => setSearch("")}>
              <X color={colors.textMuted} size={18} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <Page eyebrow="CREW STATUS" title="Check-in" scroll={false}>
      <FlatList
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.list}
        data={mode === "browse" ? filtered : []}
        initialNumToRender={12}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(member) => member.id}
        ListEmptyComponent={mode === "browse" && query.data && !query.isPending
          ? <Text style={styles.empty}>{search ? "No crew members match your search." : "No crew members have been added."}</Text>
          : null}
        ListHeaderComponent={header}
        maxToRenderPerBatch={12}
        onRefresh={() => void query.refetch()}
        refreshing={query.isRefetching}
        renderItem={({ item: member }) => (
          <View style={styles.memberCard}>
            <MemberIdentity member={member} compact />
            <Pressable
              accessibilityRole="button"
              disabled={statusMutation.isPending}
              onPress={() => statusMutation.mutate({ member, checkedIn: !member.isOnline })}
              style={[styles.statusButton, member.isOnline && styles.statusButtonOnline]}
            >
              {member.isOnline
                ? <LogOut color={colors.green} size={15} />
                : <LogIn color={colors.textMuted} size={15} />}
              <Text style={[styles.statusButtonText, member.isOnline && styles.statusButtonTextOnline]}>
                {member.isOnline ? "Check out" : "Check in"}
              </Text>
            </Pressable>
          </View>
        )}
        windowSize={7}
      />
    </Page>
  );
}

function MemberIdentity({ member, compact = false }: { member: MobileCheckInMember; compact?: boolean }) {
  const styles = useStyles();
  return (
    <View style={styles.identity}>
      {member.photoUrl ? (
        <Image accessibilityLabel={`${member.name} profile photo`} source={{ uri: member.photoUrl }} style={compact ? styles.avatarSmall : styles.avatar} />
      ) : (
        <View style={[styles.avatarFallback, compact && styles.avatarFallbackSmall]}>
          <Text style={styles.initials}>{initials(member.name)}</Text>
        </View>
      )}
      <View style={styles.identityCopy}>
        <Text numberOfLines={1} style={styles.memberName}>{member.name}</Text>
        <Text numberOfLines={1} style={styles.memberRole}>{member.role || "Crew"} · {member.memberId}</Text>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 10, paddingBottom: spacing.large },
  headerContent: { gap: spacing.medium, paddingBottom: 4 },
  modeSwitch: { flexDirection: "row", gap: 8, borderRadius: radii.medium, backgroundColor: colors.panel, padding: 5 },
  modeButton: { minHeight: 44, flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: radii.small, paddingHorizontal: 9 },
  modeButtonActive: { borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  modeText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  modeTextActive: { color: colors.amberText },
  summary: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  summaryItem: { flexDirection: "row", alignItems: "center", gap: 7 },
  summaryText: { color: colors.textMuted, fontFamily, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textFaint },
  dotOnline: { backgroundColor: colors.green },
  codeCard: { alignItems: "stretch", gap: 12, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.large },
  codeIcon: { width: 62, height: 62, alignSelf: "center", alignItems: "center", justifyContent: "center", borderRadius: 18, backgroundColor: colors.amberSoft },
  codeTitle: { color: colors.text, fontFamily, fontSize: 20, fontWeight: "900", textAlign: "center" },
  codeHelp: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
  codeInput: { minHeight: 58, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 22, fontWeight: "800", letterSpacing: 3, paddingHorizontal: 16, textAlign: "center" },
  resultCard: { alignItems: "stretch", gap: 14, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  resultCardOnline: { borderColor: colors.greenBorder },
  statePill: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: radii.pill, borderWidth: 1, paddingHorizontal: 12 },
  statePillOut: { borderColor: colors.border, backgroundColor: colors.panel },
  statePillOnline: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  stateText: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800" },
  stateTextOnline: { color: colors.green },
  secondaryButton: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  secondaryButtonText: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "700" },
  searchBox: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 13 },
  searchInput: { flex: 1, color: colors.text, fontFamily, fontSize: 14, paddingVertical: 10 },
  memberCard: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 12 },
  identity: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 11 },
  identityCopy: { flex: 1, minWidth: 0, gap: 3 },
  avatar: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.panelStrong },
  avatarSmall: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.panelStrong },
  avatarFallback: { width: 60, height: 60, alignItems: "center", justifyContent: "center", borderRadius: 30, backgroundColor: colors.amberSoft },
  avatarFallbackSmall: { width: 44, height: 44, borderRadius: 22 },
  initials: { color: colors.amberText, fontFamily, fontSize: 15, fontWeight: "900" },
  memberName: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "800" },
  memberRole: { color: colors.textMuted, fontFamily, fontSize: 10 },
  statusButton: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 11 },
  statusButtonOnline: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  statusButtonText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "900" },
  statusButtonTextOnline: { color: colors.green },
  error: { color: colors.red, fontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, textAlign: "center", paddingVertical: spacing.xlarge },
}));
