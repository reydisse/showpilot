import type { ComponentProps, ComponentType } from "react";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export function FeatureLink({
  icon: Icon,
  title,
  description,
  badge,
  onPress,
}: {
  icon: ComponentType<ComponentProps<typeof ChevronRight>>;
  title: string;
  description: string;
  badge?: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.icon}><Icon color={colors.amberText} size={21} /></View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{title}</Text>
          {badge ? <Text style={styles.badge}>{badge}</Text> : null}
        </View>
        <Text style={styles.description}>{description}</Text>
      </View>
      <ChevronRight color={colors.textFaint} size={19} />
    </Pressable>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  card: {
    minHeight: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    borderRadius: radii.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.stageRaised,
    padding: spacing.medium,
  },
  icon: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: 13, backgroundColor: colors.amberSoft },
  copy: { flex: 1, minWidth: 0, gap: 5 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  badge: { overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.amberSoft, color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "900", paddingHorizontal: 7, paddingVertical: 3 },
  description: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.99 }] },
}));
