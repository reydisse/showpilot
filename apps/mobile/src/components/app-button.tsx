import { ActivityIndicator, Pressable, StyleSheet, Text, type PressableProps } from "react-native";
import { createThemedStyles, fontFamily, radii, useAppTheme } from "@/theme/tokens";

type AppButtonProps = PressableProps & {
  label: string;
  loading?: boolean;
  variant?: "primary" | "secondary" | "danger";
};

export function AppButton({ label, loading, variant = "primary", disabled, style, ...props }: AppButtonProps) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      style={(state) => [
        styles.base,
        styles[variant],
        state.pressed && styles.pressed,
        inactive && styles.disabled,
        typeof style === "function" ? style(state) : style,
      ]}
      {...props}
    >
      {loading ? (
        <ActivityIndicator color={variant === "primary" ? colors.black : colors.text} />
      ) : (
        <Text style={[styles.label, variant === "primary" && styles.primaryLabel]} maxFontSizeMultiplier={1.5}>{label}</Text>
      )}
    </Pressable>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  base: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.medium,
    borderWidth: 1,
    paddingHorizontal: 18,
  },
  primary: { backgroundColor: colors.amber, borderColor: colors.amber },
  secondary: { backgroundColor: colors.panelStrong, borderColor: colors.border },
  danger: { backgroundColor: colors.redSoft, borderColor: colors.redBorder },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  disabled: { opacity: 0.45 },
  label: { flexShrink: 1, color: colors.text, fontFamily, fontSize: 15, lineHeight: 20, fontWeight: "700", textAlign: "center" },
  primaryLabel: { color: colors.black },
}));
