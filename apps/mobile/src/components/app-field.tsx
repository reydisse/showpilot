import { forwardRef } from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { createThemedStyles, fontFamily, radii, useAppTheme } from "@/theme/tokens";

type AppFieldProps = TextInputProps & {
  label: string;
  error?: string;
};

export const AppField = forwardRef<TextInput, AppFieldProps>(function AppField(
  { label, error, style, ...props },
  ref,
) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  return (
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        autoCapitalize="none"
        placeholderTextColor={colors.textFaint}
        selectionColor={colors.amberText}
        style={[styles.input, error && styles.inputError, style]}
        {...props}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
});

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  group: { gap: 8 },
  label: { color: colors.textMuted, fontFamily, fontSize: 13, fontWeight: "600" },
  input: {
    minHeight: 52,
    borderRadius: radii.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    color: colors.text,
    fontFamily,
    fontSize: 16,
    paddingHorizontal: 15,
  },
  inputError: { borderColor: colors.red },
  error: { color: colors.red, fontFamily, fontSize: 12 },
}));
