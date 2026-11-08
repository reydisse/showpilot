import { Text, View } from "react-native";
import { AppButton } from "./app-button";
import type { useTemplateDelete } from "../hooks/use-template-delete";
import { useAppTheme, fontFamily } from "@/theme/tokens";
export function TemplateDeleteStatus({
  state,
  active,
}: {
  state: ReturnType<typeof useTemplateDelete>;
  active: boolean;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={{ gap: 16 }}>
      {Object.entries(state.work).map(([id, attempt]) => (
        <View key={id} style={{ gap: 8 }}>
          <Text
            style={{
              color: colors.text,
              fontFamily,
              fontSize: 15,
              fontWeight: "700",
            }}
          >
            Delete “{attempt.label}”
          </Text>
          {attempt.kind === "pending" ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: colors.textMuted, fontSize: 14 }}
            >
              Confirming template deletion… Closing keeps this request while you
              remain signed in.
            </Text>
          ) : null}
          {attempt.kind === "failed" ? (
            <>
              <Text
                accessibilityRole="alert"
                style={{ color: colors.red, fontSize: 14 }}
              >
                {attempt.message}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>
                The deletion may have completed. Retrying affects only this
                saved template. Existing shows are not affected.
              </Text>
              <AppButton
                label={`Retry deletion of ${attempt.label}`}
                disabled={!active}
                onPress={() => state.retry(id)}
              />
            </>
          ) : null}
          {attempt.kind === "confirmed" ? (
            <>
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: colors.text, fontSize: 14 }}
              >
                Template deleted. Existing shows are not affected.
              </Text>
              {attempt.refresh !== "done" ? (
                <>
                  <Text
                    accessibilityRole={
                      attempt.refresh === "failed" ? "alert" : undefined
                    }
                    style={{
                      color:
                        attempt.refresh === "failed"
                          ? colors.red
                          : colors.textMuted,
                      fontSize: 14,
                    }}
                  >
                    {attempt.message ?? "Refreshing saved templates…"}
                  </Text>
                  <AppButton
                    label="Refresh saved templates"
                    variant="secondary"
                    disabled={!active || attempt.refresh === "pending"}
                    onPress={() => state.refresh(id)}
                  />
                </>
              ) : (
                <AppButton
                  label="Dismiss deletion result"
                  variant="secondary"
                  disabled={!active}
                  onPress={() => state.dismiss(id)}
                />
              )}
            </>
          ) : null}
        </View>
      ))}
    </View>
  );
}
