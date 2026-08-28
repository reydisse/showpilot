import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Redirect, router, Stack } from "expo-router";
import Flame from "lucide-react-native/icons/flame";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import ScanLine from "lucide-react-native/icons/scan-line";
import UserPlus from "lucide-react-native/icons/user-plus";
import UsersRound from "lucide-react-native/icons/users-round";
import { SvgUri } from "react-native-svg";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Pressable,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import { getMobileShowBoard, type MobileCheckInMember } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function crewPhotoUrl(value: string) {
  const candidate = value.trim();
  if (candidate.startsWith("/")) return `${SHOWPILOT_URL}${candidate}`;
  if (/^https:\/\//.test(candidate) || /^data:image\//.test(candidate)) return candidate;
  return null;
}

function formatVenueDate(now: Date, timeZone: string) {
  try {
    return new Intl.DateTimeFormat([], {
      timeZone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(now);
  } catch {
    return now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
}

function formatVenueClock(now: Date, timeZone: string, clockFormat: "12hr" | "24hr") {
  try {
    return new Intl.DateTimeFormat([], {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: clockFormat === "12hr",
    }).format(now);
  } catch {
    return now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: clockFormat === "12hr" });
  }
}

function CrewCard({ member }: { member: MobileCheckInMember }) {
  const styles = useStyles();
  const photoUrl = crewPhotoUrl(member.photoUrl);
  return (
    <View accessibilityLabel={`${member.name}, ${member.role || "Crew"}, ${member.isOnline ? "checked in" : "offline"}`} style={[styles.crewCard, member.isOnline ? styles.crewCardOnline : styles.crewCardOffline]}>
      <View style={styles.avatarWrap}>
        {photoUrl ? <Image accessibilityIgnoresInvertColors accessibilityLabel={`${member.name} profile photo`} source={{ uri: photoUrl }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarInitials}>{initials(member.name)}</Text></View>}
        <View style={[styles.avatarStatus, member.isOnline ? styles.avatarStatusOnline : styles.avatarStatusOffline]} />
      </View>
      <Text numberOfLines={2} style={styles.crewName}>{member.name}</Text>
      <Text numberOfLines={2} style={styles.crewRole}>{member.role || "Crew"}</Text>
      <View style={[styles.statusPill, member.isOnline && styles.statusPillOnline]}><Text style={[styles.statusText, member.isOnline && styles.statusTextOnline]}>{member.isOnline ? "ON CREW" : "OFFLINE"}</Text></View>
    </View>
  );
}

export default function ShowBoardScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const [now, setNow] = useState(() => new Date());
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const columns = width >= 1_000 ? 4 : width >= 700 ? 3 : 2;
  const query = useQuery({
    queryKey: ["mobile-show-board", organization?.id],
    queryFn: () => getMobileShowBoard(organization!.id),
    enabled: Boolean(organization?.id),
    refetchInterval: 3_000,
  });
  const members = useMemo(() => query.data?.members ?? [], [query.data?.members]);
  const onlineCount = members.filter((member) => member.isOnline).length;
  const checkInUrl = organization ? `${SHOWPILOT_URL}/checkin/${encodeURIComponent(organization.slug)}` : "";
  const checkInQrUrl = organization ? `${SHOWPILOT_URL}/api/checkin-qr/${encodeURIComponent(organization.slug)}` : "";

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1_000);
    return () => clearInterval(interval);
  }, []);

  if (organizationPending) return <LoadingView label="Opening Show Board…" />;
  if (!organization) return <Redirect href="/organizations" />;

  const clockFormat = query.data?.clockFormat ?? "12hr";
  const timeZone = query.data?.timeZone ?? "Africa/Accra";

  async function refreshBoard() {
    setManualRefreshing(true);
    try {
      await query.refetch();
    } finally {
      setManualRefreshing(false);
    }
  }

  function shareCheckIn() {
    void Share.share({
      title: `${organization!.name} crew check-in`,
      message: `Check in for ${organization!.name}\n${checkInUrl}`,
      url: checkInUrl,
    }).catch((error: unknown) => {
      Alert.alert("Could not share check-in", error instanceof Error ? error.message : "Try again.");
    });
  }

  const header = (
    <View style={styles.headerContent}>
      <View style={[styles.brandRow, width < 390 && styles.brandRowNarrow]}>
        <View style={styles.brandIcon}><Flame color={colors.amberText} size={27} /></View>
        <View style={styles.brandCopy}><Text adjustsFontSizeToFit numberOfLines={1} style={styles.brandName}>ShowPilot</Text><Text style={styles.brandLabel}>PRODUCTION BOARD</Text></View>
        <View style={[styles.clockCopy, width < 390 && styles.clockCopyNarrow]}><Text adjustsFontSizeToFit numberOfLines={1} style={[styles.clock, width < 390 && styles.clockNarrow]}>{formatVenueClock(now, timeZone, clockFormat)}</Text><Text numberOfLines={1} style={[styles.date, width < 390 && styles.dateNarrow]}>{formatVenueDate(now, timeZone)}</Text></View>
      </View>

      <View style={styles.summaryRow}>
        <View style={styles.summaryItem}><View style={[styles.summaryDot, styles.summaryDotOnline]} /><Text style={styles.summaryText}><Text style={styles.summaryNumber}>{onlineCount}</Text> on crew</Text></View>
        <View style={styles.summaryItem}><View style={styles.summaryDot} /><Text style={styles.summaryText}><Text style={styles.summaryNumber}>{members.length - onlineCount}</Text> offline</Text></View>
      </View>

      <View style={[styles.checkInCard, width < 390 && styles.checkInCardNarrow]}>
        <View accessibilityLabel="Crew check-in QR code" style={styles.qrWrap}><SvgUri height={116} uri={checkInQrUrl} width={116} /></View>
        <View style={styles.checkInCopy}><View style={styles.checkInHeading}><ScanLine color={colors.amberText} size={18} /><Text style={styles.checkInTitle}>Scan to serve</Text></View><Text style={styles.checkInHint}>Crew can scan this code with their camera and check in from any phone.</Text><View style={styles.checkInActions}><AppButton label="Open" onPress={() => void Linking.openURL(checkInUrl)} style={styles.checkInAction} variant="secondary" /><AppButton label="Share" onPress={shareCheckIn} style={styles.checkInAction} /></View></View>
      </View>

      <View style={styles.sectionRow}><View><Text style={styles.sectionEyebrow}>LIVE CREW</Text><Text style={styles.sectionTitle}>{members.length ? `${members.length} team ${members.length === 1 ? "member" : "members"}` : "Your board is ready"}</Text></View><Pressable accessibilityLabel="Refresh Show Board" accessibilityRole="button" disabled={manualRefreshing} onPress={() => void refreshBoard()} style={[styles.refreshButton, manualRefreshing && styles.disabled]}>{manualRefreshing ? <ActivityIndicator color={colors.amberText} /> : <RefreshCw color={colors.textMuted} size={18} />}</Pressable></View>
      {query.error ? <Pressable accessibilityRole="button" onPress={() => void query.refetch()} style={styles.errorCard}><Text style={styles.errorText}>{query.error.message}</Text><Text style={styles.retryText}>Tap to retry</Text></Pressable> : null}
    </View>
  );

  return (
    <Page scroll={false}>
      <Stack.Screen options={{ title: "Show Board" }} />
      <FlatList
        columnWrapperStyle={styles.columns}
        contentContainerStyle={styles.list}
        data={members}
        initialNumToRender={12}
        key={`show-board-${columns}`}
        keyExtractor={(member) => member.id}
        ListEmptyComponent={!query.isPending && !query.error ? <View style={styles.emptyCard}><UsersRound color={colors.textFaint} size={34} /><Text style={styles.emptyTitle}>No crew members yet</Text><Text style={styles.emptyCopy}>Add your crew and they will appear here automatically as they check in.</Text><AppButton label="Open crew roster" onPress={() => router.push("/team-crew")} /><View style={styles.emptySpacer}><UserPlus color={colors.amberText} size={16} /><Text style={styles.emptyHint}>Names, roles, photos, and live status stay synchronized.</Text></View></View> : null}
        ListHeaderComponent={header}
        maxToRenderPerBatch={12}
        numColumns={columns}
        onRefresh={() => void refreshBoard()}
        refreshing={manualRefreshing}
        renderItem={({ item }) => <View style={styles.cardColumn}><CrewCard member={item} /></View>}
        showsVerticalScrollIndicator={false}
        windowSize={7}
      />
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 10, paddingBottom: 100 },
  columns: { gap: 10 },
  headerContent: { gap: spacing.large, paddingBottom: 4 },
  brandRow: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: 11 },
  brandRowNarrow: { flexWrap: "wrap" },
  brandIcon: { width: 50, height: 50, alignItems: "center", justifyContent: "center", borderRadius: 15, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  brandCopy: { flex: 1, minWidth: 0, gap: 2 },
  brandName: { color: colors.amberText, fontFamily, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  brandLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  clockCopy: { flex: 1.35, minWidth: 0, alignItems: "flex-end", gap: 3 },
  clockCopyNarrow: { flexBasis: "100%", alignItems: "flex-start", paddingLeft: 61 },
  clock: { width: "100%", color: colors.text, fontFamily: "monospace", fontSize: 20, fontWeight: "800", textAlign: "right" },
  clockNarrow: { textAlign: "left" },
  date: { maxWidth: "100%", color: colors.textMuted, fontFamily, fontSize: 11, textAlign: "right" },
  dateNarrow: { textAlign: "left" },
  summaryRow: { flexDirection: "row", flexWrap: "wrap", gap: 16, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.borderSoft, paddingVertical: 12 },
  summaryItem: { flexDirection: "row", alignItems: "center", gap: 7 },
  summaryDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.textFaint },
  summaryDotOnline: { backgroundColor: colors.green },
  summaryText: { color: colors.textMuted, fontFamily, fontSize: 12 },
  summaryNumber: { color: colors.text, fontWeight: "900" },
  checkInCard: { flexDirection: "row", alignItems: "center", gap: 15, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 14 },
  checkInCardNarrow: { flexDirection: "column", alignItems: "stretch" },
  qrWrap: { borderRadius: 13, backgroundColor: colors.white, padding: 5 },
  checkInCopy: { flex: 1, minWidth: 0, gap: 8 },
  checkInHeading: { flexDirection: "row", alignItems: "center", gap: 7 },
  checkInTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "900" },
  checkInHint: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16 },
  checkInActions: { flexDirection: "row", gap: 7 },
  checkInAction: { flex: 1, minHeight: 40 },
  sectionRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 12 },
  sectionEyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  sectionTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "800", marginTop: 3 },
  refreshButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  cardColumn: { flex: 1, minWidth: 0 },
  crewCard: { minHeight: 210, alignItems: "center", justifyContent: "center", gap: 7, borderRadius: radii.large, borderWidth: 1, backgroundColor: colors.stageRaised, padding: 12 },
  crewCardOnline: { borderColor: colors.amberBorder },
  crewCardOffline: { borderColor: colors.borderSoft, opacity: 0.62 },
  avatarWrap: { width: 76, height: 76, marginBottom: 2 },
  avatar: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.panelStrong },
  avatarFallback: { width: 76, height: 76, alignItems: "center", justifyContent: "center", borderRadius: 38, backgroundColor: colors.panelStrong },
  avatarInitials: { color: colors.amberText, fontFamily, fontSize: 20, fontWeight: "900" },
  avatarStatus: { position: "absolute", right: 3, bottom: 3, width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: colors.stageRaised },
  avatarStatusOnline: { backgroundColor: colors.green },
  avatarStatusOffline: { backgroundColor: colors.textFaint },
  crewName: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 18, fontWeight: "800", textAlign: "center" },
  crewRole: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 14, textAlign: "center" },
  statusPill: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 9, paddingVertical: 5 },
  statusPillOnline: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  statusText: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  statusTextOnline: { color: colors.green },
  errorCard: { gap: 4, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft, padding: 12 },
  errorText: { color: colors.red, fontFamily, fontSize: 12, lineHeight: 18 },
  retryText: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "800" },
  emptyCard: { alignItems: "center", gap: 11, borderRadius: radii.large, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.xlarge },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 19, fontWeight: "900" },
  emptyCopy: { maxWidth: 420, color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center" },
  emptySpacer: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4 },
  emptyHint: { flex: 1, color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 15 },
  disabled: { opacity: 0.45 },
}));
