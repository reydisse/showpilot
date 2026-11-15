import { ActivityIndicator, StyleSheet, View } from "react-native";
import { BrandMark } from "@/components/brand-mark";
import { createThemedStyles, useAppTheme } from "@/theme/tokens";

export function LoadingView({ label = "Loading ShowPilot…" }: { label?: string }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={styles.root}>
      <BrandMark size={56} />
      <ActivityIndicator color={colors.amberText} accessibilityLabel={label} />
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, backgroundColor: colors.stage },
}));
