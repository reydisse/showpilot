import { useState, type PropsWithChildren, type ReactNode } from "react";
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createThemedStyles, fontFamily, spacing, useAppTheme } from "@/theme/tokens";

type PageProps = PropsWithChildren<{
  title?: string;
  eyebrow?: string;
  subtitle?: string;
  action?: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  maxWidth?: number;
}>;

export function Page({ title, eyebrow, subtitle, action, scroll = true, onRefresh, maxWidth = 1040, children }: PageProps) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [manualRefresh, setManualRefresh] = useState(false);
  const refresh = onRefresh
    ? async () => {
        setManualRefresh(true);
        try {
          await onRefresh();
        } finally {
          setManualRefresh(false);
        }
      }
    : undefined;
  const content = (
    <View style={[styles.content, { maxWidth }]}>
      {title || eyebrow || subtitle || action ? (
        <View style={styles.header}>
          <View style={styles.heading}>
            {eyebrow ? <Text style={styles.eyebrow} maxFontSizeMultiplier={1.5}>{eyebrow}</Text> : null}
            {title ? <Text style={styles.title} maxFontSizeMultiplier={1.7}>{title}</Text> : null}
            {subtitle ? <Text style={styles.subtitle} maxFontSizeMultiplier={1.7}>{subtitle}</Text> : null}
          </View>
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {scroll ? (
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.scroll}
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          keyboardShouldPersistTaps="handled"
          refreshControl={refresh ? <RefreshControl refreshing={manualRefresh} onRefresh={refresh} tintColor={colors.amberText} colors={[colors.amberText]} /> : undefined}
        >
          {content}
        </ScrollView>
      ) : content}
    </SafeAreaView>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.stage },
  scroll: { flexGrow: 1 },
  content: { width: "100%", flex: 1, alignSelf: "center", gap: spacing.large, padding: spacing.large },
  header: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: 16 },
  heading: { flex: 1, minWidth: 0, gap: 5 },
  eyebrow: { flexShrink: 1, color: colors.amberText, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "800", letterSpacing: 1.7, textTransform: "uppercase" },
  title: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 29, lineHeight: 36, fontWeight: "800", letterSpacing: -0.7 },
  subtitle: { flexShrink: 1, color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, paddingTop: 2 },
}));
