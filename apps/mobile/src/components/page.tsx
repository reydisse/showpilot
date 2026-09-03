import { useState, type PropsWithChildren, type ReactNode } from "react";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import { router, type Href } from "expo-router";
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
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
  backTo?: Href;
  backLabel?: string;
}>;

export function Page({ title, eyebrow, subtitle, action, scroll = true, onRefresh, maxWidth = 1040, backTo, backLabel = "Back", children }: PageProps) {
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
      {title || eyebrow || subtitle || action || backTo ? (
        <View style={styles.header}>
          {backTo ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={backLabel}
              hitSlop={10}
              onPress={() => router.canGoBack() ? router.back() : router.replace(backTo)}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <ChevronLeft color={colors.text} size={25} />
            </Pressable>
          ) : null}
          <View style={styles.headerBody}>
            <View style={styles.heading}>
              {eyebrow ? <Text style={styles.eyebrow} maxFontSizeMultiplier={1.5}>{eyebrow}</Text> : null}
              {title ? <Text style={styles.title} maxFontSizeMultiplier={1.7}>{title}</Text> : null}
              {subtitle ? <Text style={styles.subtitle} maxFontSizeMultiplier={1.7}>{subtitle}</Text> : null}
            </View>
            {action}
          </View>
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
  content: { width: "100%", flex: 1, alignSelf: "center", gap: 12, paddingHorizontal: spacing.medium, paddingVertical: 8 },
  header: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5 },
  backButton: { width: 39, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -9, borderRadius: 20 },
  pressed: { opacity: 0.58 },
  headerBody: { minWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  heading: { flex: 1, minWidth: 0, gap: 2 },
  eyebrow: { flexShrink: 1, color: colors.amberText, fontFamily, fontSize: 11, lineHeight: 16, fontWeight: "800", letterSpacing: 1.7, textTransform: "uppercase" },
  title: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 24, lineHeight: 30, fontWeight: "800", letterSpacing: -0.5 },
  subtitle: { flexShrink: 1, color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
}));
