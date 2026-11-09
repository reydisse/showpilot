import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { AppButton } from "./app-button";
import type { useRundownChange } from "../hooks/use-rundown-change";
import { useAppTheme } from "@/theme/tokens";

export function RundownChangeStatus({
  state,
  active,
  revision,
  itemIds,
}: {
  state: ReturnType<typeof useRundownChange>;
  active: boolean;
  revision: number;
  itemIds: string[];
}) {
  const { colors } = useAppTheme();
  const [now, setNow] = useState(Date.now);
  const attempt = state.attempt;
  useEffect(() => {
    if (
      attempt?.kind !== "confirmed" ||
      attempt.command.action !== "remove-item"
    )
      return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [attempt]);
  if (!attempt) return null;
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 };
  const action =
    attempt.command.action === "reset"
      ? "Reset timing"
      : attempt.command.action === "clear-all"
        ? "Clear rundown"
        : attempt.command.action === "restore-item"
          ? "Restore"
          : "Remove";
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 14,
      }}
    >
      <Text style={{ ...text, fontWeight: "700" }}>
        {action}: {attempt.label}
      </Text>
      {!active ? (
        <Text style={text}>
          Reconnect with rundown access to continue this request.
        </Text>
      ) : null}
      {attempt.kind === "pending" ? (
        <Text accessibilityLiveRegion="polite" style={text}>
          Confirming the action… Leaving this screen keeps the request during
          this app session.
        </Text>
      ) : null}
      {attempt.kind === "failed" ? (
        <>
          <Text
            accessibilityRole="alert"
            style={{ ...text, color: colors.red }}
          >
            {attempt.message}
          </Text>
          <Text style={text}>
            The action may have completed. Retry checks the original request and
            reviewed rundown.
          </Text>
          <AppButton
            label="Retry original rundown action"
            disabled={!active}
            onPress={state.retry}
          />
        </>
      ) : null}
      {attempt.kind === "confirmed" ? (
        <>
          <Text accessibilityLiveRegion="polite" style={text}>
            {attempt.result.outcome === "applied"
              ? "Action accepted. The current rundown may include later changes by other operators."
              : attempt.result.outcome === "conflict"
                ? "The rundown changed. This request was not applied again. Refresh and review the current rundown before starting another action."
                : "This action is no longer available. Refresh to see the current rundown."}
          </Text>
          {attempt.result.outcome === "applied" &&
          attempt.command.action === "remove-item" &&
          attempt.refresh === "done" &&
          now < attempt.command.initiatedAt + 30_000 &&
          !itemIds.includes(attempt.command.itemId) ? (
            <>
              <Text style={text}>
                Undo restores the item without restarting its timer.
              </Text>
              <AppButton
                label={`Undo removal of ${attempt.label}`}
                disabled={!active}
                onPress={() => state.undo(revision)}
              />
            </>
          ) : null}
          {attempt.refresh !== "done" ? (
            <>
              <Text
                accessibilityRole={
                  attempt.refresh === "failed" ? "alert" : undefined
                }
                style={text}
              >
                {attempt.message ?? "Refreshing the rundown…"}
              </Text>
              <AppButton
                label="Refresh rundown result"
                variant="secondary"
                disabled={!active || attempt.refresh === "pending"}
                onPress={state.refresh}
              />
            </>
          ) : (
            <AppButton
              label="Dismiss rundown result"
              variant="secondary"
              disabled={!active}
              onPress={state.dismiss}
            />
          )}
        </>
      ) : null}
    </View>
  );
}
