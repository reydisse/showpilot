import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import BellRing from "lucide-react-native/icons/bell-ring";
import Radio from "lucide-react-native/icons/radio";
import ShieldCheck from "lucide-react-native/icons/shield-check";
import { Page } from "@/components/page";
import { ShowCard } from "@/components/show-card";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function HomeScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { organization, data, isPending, error, refetch } = useMobileBootstrap();
  if (!organization) return <Redirect href="/organizations" />;

  const liveShow = data?.shows.find((show) => show.status === "running" || show.status === "paused");
  const nextShow = liveShow ?? data?.shows[0];

  return (
    <Page eyebrow="COMMAND CENTER" title={organization.name} onRefresh={refetch}>
      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Could not sync ShowPilot</Text>
          <Text style={styles.errorCopy}>{error.message}</Text>
          <Text onPress={() => refetch()} style={styles.retry}>Try again</Text>
        </View>
      ) : null}
      {isPending ? <ActivityIndicator color={colors.amberText} size="large" /> : null}
      {data ? (
        <>
          <View style={styles.stats}>
            <View style={styles.stat}><Radio size={18} color={liveShow ? colors.green : colors.textFaint} /><Text style={styles.statValue}>{liveShow ? "Live" : "Standby"}</Text><Text style={styles.statLabel}>show state</Text></View>
            <View style={styles.stat}><BellRing size={18} color={data.unreadNotifications ? colors.amberText : colors.textFaint} /><Text style={styles.statValue}>{data.unreadNotifications}</Text><Text style={styles.statLabel}>unread</Text></View>
            <View style={styles.stat}><ShieldCheck size={18} color={colors.amberText} /><Text numberOfLines={1} style={styles.statValue}>{data.identity.role}</Text><Text style={styles.statLabel}>your role</Text></View>
          </View>
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{liveShow ? "ACTIVE SHOW" : "NEXT SHOW"}</Text>
            {nextShow ? <ShowCard show={nextShow} timeZone={data.timeZone} onPress={() => router.push({ pathname: "/show/[showId]", params: { showId: nextShow.id } })} /> : <Text style={styles.empty}>No upcoming shows. Open Shows to schedule one if your role allows it.</Text>}
          </View>
          <View style={styles.syncNote}>
            <Text style={styles.syncTitle}>One live source of truth</Text>
            <Text style={styles.syncCopy}>This app reads the same organization, rundown, permissions, and notifications as web and desktop.</Text>
          </View>
        </>
      ) : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  stats: { flexDirection: "row", gap: 10 },
  stat: { flex: 1, minWidth: 0, gap: 6, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 13 },
  statValue: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "800", textTransform: "capitalize" },
  statLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "600" },
  section: { gap: 12 },
  sectionLabel: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1.6 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  syncNote: { gap: 7, borderLeftWidth: 2, borderLeftColor: colors.amberText, paddingLeft: 14 },
  syncTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
  syncCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20 },
  errorCard: { gap: 8, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft, padding: spacing.medium },
  errorTitle: { color: colors.red, fontFamily, fontSize: 15, fontWeight: "800" },
  errorCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 19 },
  retry: { color: colors.amberText, fontFamily, fontSize: 13, fontWeight: "700" },
}));
