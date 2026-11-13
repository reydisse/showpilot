import { useState } from "react";
import { Text, View } from "react-native";
import { AppButton } from "./app-button";
import { useProPresenterCommand } from "../hooks/use-propresenter-command";
import { controlMobileProPresenter } from "../lib/mobile-api";
import { useAppTheme } from "@/theme/tokens";

export function ProPresenterControls({
  scope,
  ready,
}: {
  scope: { orgId: string; userId: string; showId: string };
  ready: boolean;
}) {
  const { colors } = useAppTheme();
  const state = useProPresenterCommand(scope, {
    enabled: true,
    ready,
    call: controlMobileProPresenter,
  });
  const [clear, setClear] = useState(false);
  const attempt = state.attempt;
  const result = attempt?.kind === "confirmed" ? attempt.result : null;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <AppButton
          label="Previous slide"
          variant="secondary"
          disabled={!state.canStart || clear}
          onPress={() => state.start("previous")}
        />
        <AppButton
          label="Next slide"
          variant="secondary"
          disabled={!state.canStart || clear}
          onPress={() => state.start("next")}
        />
        <AppButton
          label="Clear"
          variant="secondary"
          disabled={!state.canStart || clear}
          onPress={() => setClear(true)}
        />
      </View>
      {clear ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.text }}>
            Clear the live ProPresenter output?
          </Text>
          <Text style={{ color: colors.textMuted }}>
            This removes the current presentation output for everyone watching.
          </Text>
          <AppButton
            label="Clear ProPresenter output"
            variant="danger"
            disabled={!state.canStart}
            onPress={() => {
              if (state.canStart) {
                state.start("clear");
                setClear(false);
              }
            }}
          />
          <AppButton
            label="Cancel"
            variant="secondary"
            onPress={() => setClear(false)}
          />
        </View>
      ) : null}
      {!ready ? (
        <Text accessibilityRole="alert" style={{ color: colors.amberText }}>
          Slide controls are unavailable until live sync and the Bridge are
          ready.
        </Text>
      ) : null}
      {attempt ? (
        <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
          <Text style={{ color: colors.text }}>{attempt.label}</Text>
          <Text
            accessibilityRole={
              attempt.kind === "failed" || result?.status === "uncertain"
                ? "alert"
                : undefined
            }
            style={{ color: colors.textMuted }}
          >
            {attempt.kind === "pending"
              ? "Waiting for confirmation…"
              : attempt.kind === "failed"
                ? attempt.message
                : attempt.result.message}
          </Text>
          {attempt.kind === "failed" ||
          (result &&
            result.status !== "confirmed" &&
            result.status !== "rejected") ? (
            <AppButton
              label="Check command status"
              variant="secondary"
              disabled={attempt.kind === "pending"}
              onPress={state.check}
            />
          ) : null}
          {result &&
          (result.status === "uncertain" || result.status === "rejected") ? (
            <>
              <Text style={{ color: colors.textMuted }}>
                Checking status does not send another slide command.
              </Text>
              <AppButton
                label="I checked the output"
                variant="secondary"
                onPress={state.acknowledge}
              />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
