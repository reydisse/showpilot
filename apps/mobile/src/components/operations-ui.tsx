import type { PropsWithChildren, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { createThemedStyles, fontFamily, radii, spacing } from "@/theme/tokens";

export function OperationsPanel({ title, detail, action, children }: PropsWithChildren<{ title: string; detail?: string; action?: ReactNode }>) {
  const styles = useStyles();
  return (
    <View style={styles.panel}>
      <View style={styles.panelHeader}>
        <View style={styles.panelCopy}>
          <Text style={styles.panelTitle}>{title}</Text>
          {detail ? <Text style={styles.panelDetail}>{detail}</Text> : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

export function OperationsStat({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "good" | "warning" | "danger" }) {
  const styles = useStyles();
  const toneStyle = tone === "good" ? styles.goodStat : tone === "warning" ? styles.warningStat : tone === "danger" ? styles.dangerStat : undefined;
  return (
    <View style={[styles.stat, toneStyle]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function OperationsRow({ title, detail, status, onPress }: { title: string; detail?: string; status?: string; onPress?: () => void }) {
  const styles = useStyles();
  const content = (
    <>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}
    </>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>{content}</Pressable>
  ) : <View style={styles.row}>{content}</View>;
}

export function OperationsEmpty({ children }: PropsWithChildren) {
  const styles = useStyles();
  return <Text style={styles.empty}>{children}</Text>;
}

export function OperationsError({ message }: { message: string }) {
  const styles = useStyles();
  return <Text accessibilityRole="alert" style={styles.error}>{message}</Text>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  panel: { gap: spacing.medium, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.medium },
  panelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  panelCopy: { flex: 1, minWidth: 0, gap: 3 },
  panelTitle: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 16, lineHeight: 22, fontWeight: "800" },
  panelDetail: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  stat: { minWidth: 92, flex: 1, gap: 3, borderRadius: radii.medium, backgroundColor: colors.panel, padding: 13 },
  goodStat: { backgroundColor: colors.greenSoft },
  warningStat: { backgroundColor: colors.amberSoft },
  dangerStat: { backgroundColor: colors.redSoft },
  statValue: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 23, lineHeight: 29, fontWeight: "900" },
  statLabel: { flexShrink: 1, color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "700", textTransform: "uppercase" },
  row: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSoft, paddingVertical: 10 },
  rowCopy: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 14, lineHeight: 20, fontWeight: "700" },
  rowDetail: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  status: { flexShrink: 1, overflow: "hidden", borderRadius: radii.pill, backgroundColor: colors.panelStrong, color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 5, textTransform: "uppercase" },
  pressed: { opacity: 0.65 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", paddingVertical: 18 },
  error: { borderRadius: radii.medium, backgroundColor: colors.redSoft, color: colors.red, fontFamily, fontSize: 13, lineHeight: 19, padding: 13 },
}));
