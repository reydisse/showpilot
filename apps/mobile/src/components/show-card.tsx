import { CalendarDays, ChevronRight, Clock3, MapPin } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileBootstrap } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type Show = MobileBootstrap["shows"][number];

function showLabel(show: Show) {
  return show.name.trim() || "Untitled show";
}

function timeLabel(value: string | null) {
  if (!value) return "Time not set";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Time not set" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ShowCard({ show, onPress }: { show: Show; onPress?: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const live = show.status === "running" || show.status === "paused";
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.card, live && styles.liveCard, pressed && styles.pressed]}
    >
      <View style={styles.topline}>
        <Text numberOfLines={2} style={styles.title}>{showLabel(show)}</Text>
        <View style={[styles.status, live && styles.liveStatus]}><Text style={[styles.statusText, live && styles.liveStatusText]}>{live ? "LIVE" : show.status.toUpperCase()}</Text></View>
        {onPress ? <ChevronRight size={18} color={colors.textFaint} /> : null}
      </View>
      <View style={styles.meta}>
        <View style={styles.metaItem}><CalendarDays size={14} color={colors.textFaint} /><Text style={styles.metaText}>{show.serviceDate}</Text></View>
        <View style={styles.metaItem}><Clock3 size={14} color={colors.textFaint} /><Text style={styles.metaText}>{timeLabel(show.scheduledStartTime)}</Text></View>
        {show.location ? <View style={styles.metaItem}><MapPin size={14} color={colors.textFaint} /><Text numberOfLines={1} style={styles.metaText}>{show.location}</Text></View> : null}
      </View>
      <Text style={styles.items}>{show.itemCount} rundown {show.itemCount === 1 ? "item" : "items"}</Text>
    </Pressable>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  card: { gap: spacing.medium, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  liveCard: { borderColor: colors.greenBorder },
  pressed: { opacity: 0.76, transform: [{ scale: 0.995 }] },
  topline: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  title: { flex: 1, color: colors.text, fontFamily, fontSize: 17, lineHeight: 22, fontWeight: "700" },
  status: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: colors.panelStrong },
  liveStatus: { backgroundColor: colors.greenSoft },
  statusText: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  liveStatusText: { color: colors.green },
  meta: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  metaText: { color: colors.textMuted, fontFamily, fontSize: 12 },
  items: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "700" },
}));
