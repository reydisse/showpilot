import { ActivityIndicator } from "react-native";
import { useAppTheme } from "@/theme/tokens";

export function QuietActivity({ label = "Loading" }: { label?: string }) {
  const { colors } = useAppTheme();
  return <ActivityIndicator accessibilityLabel={label} color={colors.amberText} size="small" />;
}
