import WifiOff from "lucide-react-native/icons/wifi-off";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { BrandMark } from "@/components/brand-mark";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export function SessionRecoveryView({
  error,
  retrying,
  onRetry,
}: {
  error?: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <BrandMark size={58} />
        <View style={styles.icon}><WifiOff color={colors.amberText} size={22} /></View>
        <Text style={styles.title}>Connection interrupted</Text>
        <Text style={styles.copy}>ShowPilot could not verify your session. Your sign-in is still stored safely on this device.</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <AppButton label="Try again" loading={retrying} onPress={onRetry} />
      </View>
    </View>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.stage, padding: spacing.large },
  card: { width: "100%", maxWidth: 440, alignItems: "center", gap: 14, borderRadius: radii.large, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: spacing.xlarge },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amberSoft },
  title: { color: colors.text, fontFamily, fontSize: 22, fontWeight: "800", textAlign: "center" },
  copy: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, textAlign: "center" },
  error: { width: "100%", color: colors.red, fontFamily, fontSize: 12, lineHeight: 18, textAlign: "center" },
}));
