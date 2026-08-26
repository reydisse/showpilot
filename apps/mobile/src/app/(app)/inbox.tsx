import { useQueryClient } from "@tanstack/react-query";
import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import Bell from "lucide-react-native/icons/bell";
import CalendarCheck2 from "lucide-react-native/icons/calendar-check-2";
import CheckCheck from "lucide-react-native/icons/check-check";
import Info from "lucide-react-native/icons/info";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect } from "expo-router";
import * as Haptics from "@/lib/haptics";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/mobile-api";
import { openNotificationDestination } from "@/lib/notification-destination";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function InboxScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const queryClient = useQueryClient();
  const { organization, data, isPending, isRefetching, error, refetch } = useMobileBootstrap();
  const organizationId = organization?.id;
  const unreadCount = data?.unreadNotifications ?? 0;
  if (!organizationId) return <Redirect href="/organizations" />;
  const activeOrganizationId: string = organizationId;

  async function openNotification(id: string, alreadyRead: boolean, actionUrl: string) {
    openNotificationDestination(actionUrl);
    if (!alreadyRead) {
      try {
        await markNotificationRead(activeOrganizationId, id);
        await Haptics.selectionAsync();
        await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap", activeOrganizationId] });
      } catch (markError) {
        Alert.alert("Notification not marked read", markError instanceof Error ? markError.message : "Try again from the Inbox.");
      }
    }
  }

  async function markAllRead() {
    try {
      await markAllNotificationsRead(activeOrganizationId);
      await Haptics.selectionAsync();
      await queryClient.invalidateQueries({ queryKey: ["mobile-bootstrap", activeOrganizationId] });
    } catch (markError) {
      Alert.alert("Notifications not updated", markError instanceof Error ? markError.message : "Try again in a moment.");
    }
  }

  return (
    <Page eyebrow="ACTIVITY" title="Inbox" refreshing={isRefetching} onRefresh={refetch} action={unreadCount > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="Mark all notifications read" onPress={markAllRead} style={({ pressed }) => [styles.markAll, pressed && styles.pressed]}><CheckCheck color={colors.amberText} size={18} /><Text style={styles.markAllText}>Read all</Text></Pressable> : null}>
      <Text style={styles.intro}>{unreadCount} unread notifications</Text>
      {isPending ? <Text style={styles.muted}>Syncing notifications…</Text> : null}
      {error ? <Text onPress={() => refetch()} style={styles.error}>{error.message} · Tap to retry</Text> : null}
      <View style={styles.list}>
        {data?.notifications.map((notification) => {
          const read = Boolean(notification.readAt);
          const Icon = notification.severity === "critical" || notification.severity === "warning" ? AlertTriangle : notification.type === "assignment" ? CalendarCheck2 : Info;
          return (
            <Pressable accessibilityRole="button" accessibilityLabel={`${read ? "Read" : "Unread"} notification: ${notification.title}`} key={notification.id} onPress={() => openNotification(notification.id, read, notification.actionUrl)} style={({ pressed }) => [styles.card, !read && styles.unread, pressed && styles.pressed]}>
              <View style={styles.icon}><Icon size={19} color={!read ? colors.amberText : colors.textFaint} /></View>
              <View style={styles.copy}>
                <View style={styles.titleRow}><Text style={styles.title}>{notification.title}</Text>{!read ? <View style={styles.dot} /> : null}</View>
                <Text style={styles.message}>{notification.message}</Text>
                <Text style={styles.time}>{new Date(notification.createdAt).toLocaleString()}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {data && data.notifications.length === 0 ? (
        <View style={styles.empty}><Bell size={25} color={colors.textFaint} /><Text style={styles.emptyTitle}>All quiet</Text><Text style={styles.muted}>New assignments, mentions, alerts, and show activity will appear here.</Text></View>
      ) : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  intro: { color: colors.textMuted, fontFamily, fontSize: 14, marginTop: -12 },
  markAll: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radii.small, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, paddingHorizontal: 11 },
  markAllText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  list: { gap: 10 },
  card: { flexDirection: "row", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  unread: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  pressed: { opacity: 0.72 },
  icon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.panelStrong },
  copy: { flex: 1, gap: 6 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, fontWeight: "700" },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.amber },
  message: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 19 },
  time: { color: colors.textFaint, fontFamily, fontSize: 10 },
  empty: { alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.xlarge },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  muted: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 19, textAlign: "center" },
  error: { color: colors.red, fontFamily, fontSize: 13 },
}));
