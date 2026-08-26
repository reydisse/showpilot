import type { PropsWithChildren, ReactNode } from "react";
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createThemedStyles, fontFamily, spacing, useAppTheme } from "@/theme/tokens";

type PageProps = PropsWithChildren<{
  title?: string;
  eyebrow?: string;
  action?: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  maxWidth?: number;
}>;

export function Page({ title, eyebrow, action, scroll = true, refreshing = false, onRefresh, maxWidth = 1040, children }: PageProps) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const content = (
    <View style={[styles.content, { maxWidth }]}>
      {title || eyebrow || action ? (
        <View style={styles.header}>
          <View style={styles.heading}>
            {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
            {title ? <Text style={styles.title}>{title}</Text> : null}
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
          refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.amberText} colors={[colors.amberText]} /> : undefined}
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
  heading: { flex: 1, gap: 5 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1.7, textTransform: "uppercase" },
  title: { color: colors.text, fontFamily, fontSize: 29, fontWeight: "800", letterSpacing: -0.7 },
}));
