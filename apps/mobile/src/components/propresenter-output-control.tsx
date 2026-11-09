import { useState } from "react";
import { Text, View } from "react-native";
import { useAppTheme } from "@/theme/tokens";
import { AppButton } from "./app-button";
import { useProPresenterOutput } from "../hooks/use-propresenter-output";
import { useScreenFocus } from "../hooks/use-screen-polling";
import {
  readMobileProPresenterOutput,
  writeMobileProPresenterOutput,
} from "../lib/mobile-api";

export function ProPresenterOutputControl({
  scope,
}: {
  scope: { orgId: string; userId: string };
}) {
  const { colors } = useAppTheme();
  const isScreenFocused = useScreenFocus();
  const control = useProPresenterOutput(scope, {
    enabled: isScreenFocused,
    read: readMobileProPresenterOutput,
    send: writeMobileProPresenterOutput,
  });
  const [review, setReview] =
    useState<ReturnType<typeof control.prepare>>(null);
  const { state, attempt } = control;
  const result = attempt?.kind === "confirmed" ? attempt.result : null;
  return (
    <View style={{ gap: 10 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>
        {!state.data
          ? state.isError
            ? "Stage output state is unavailable."
            : "Reading stage output…"
          : `${state.isError ? "Last confirmed: " : ""}ProPresenter slides are ${state.data.enabled ? "enabled" : "disabled"} on stage displays.`}
      </Text>
      <Text style={{ color: colors.textMuted }}>
        This changes ProPresenter lyrics and scripture on stage displays across
        this workspace. Connected displays apply it on their next update.
      </Text>
      {state.isError ? (
        <>
          <Text accessibilityRole="alert" style={{ color: colors.amberText }}>
            Could not read current output.{" "}
            {new Date(state.errorUpdatedAt).toLocaleTimeString()}
          </Text>
          <AppButton
            label={state.isFetching ? "Reading output…" : "Retry output state"}
            variant="secondary"
            disabled={state.isFetching}
            onPress={() => void state.refetch()}
          />
        </>
      ) : null}
      <AppButton
        label={
          state.data?.enabled
            ? "Hide slides from stage displays"
            : "Show slides on stage displays"
        }
        variant="secondary"
        disabled={!control.canStart || !!review}
        onPress={() => setReview(control.prepare())}
      />
      {review ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.text }}>
            {review.enabled
              ? "Show ProPresenter slides on all stage displays?"
              : "Hide ProPresenter slides from all stage displays?"}
          </Text>
          {!control.matches(review) ? (
            <Text accessibilityRole="alert" style={{ color: colors.amberText }}>
              The output state or access changed. Cancel and review the latest
              state.
            </Text>
          ) : null}
          <AppButton
            label={
              review.enabled ? "Confirm show slides" : "Confirm hide slides"
            }
            variant="danger"
            disabled={!control.matches(review)}
            onPress={() => {
              control.confirm(review);
              setReview(null);
            }}
          />
          <AppButton
            label="Cancel output change"
            variant="secondary"
            onPress={() => setReview(null)}
          />
        </View>
      ) : null}
      {attempt ? (
        <View accessibilityLiveRegion="polite" style={{ gap: 8 }}>
          <Text style={{ color: colors.text }}>{attempt.label}</Text>
          <Text
            accessibilityRole={
              attempt.kind === "failed" ||
              (result && result.outcome !== "applied")
                ? "alert"
                : undefined
            }
            style={{ color: colors.textMuted }}
          >
            {attempt.kind === "pending"
              ? "Waiting for output confirmation…"
              : attempt.kind === "failed"
                ? attempt.message
                : result?.outcome === "applied"
                  ? "Output change saved."
                  : result?.outcome === "superseded"
                    ? "This command was saved, then another output change replaced it."
                    : result?.outcome === "expired"
                      ? "This command expired without changing output. Review the current state before starting another."
                      : "The output changed after your review. Your command did not overwrite it."}
          </Text>
          {attempt.kind === "confirmed" ? (
            <Text style={{ color: colors.textMuted }}>
              {new Date(attempt.at).toLocaleTimeString()}
            </Text>
          ) : null}
          {attempt.kind === "failed" ? (
            <AppButton
              label="Recover original output change"
              variant="secondary"
              onPress={control.retry}
            />
          ) : null}
          {attempt.kind === "confirmed" && attempt.refresh !== "done" ? (
            <>
              <Text
                accessibilityRole={
                  attempt.refresh === "failed" ? "alert" : undefined
                }
                style={{ color: colors.textMuted }}
              >
                {attempt.message ??
                  (attempt.refresh === "pending"
                    ? "Refreshing current output state…"
                    : "Command result saved. Refresh the current output state.")}
              </Text>
              <AppButton
                label="Refresh output state"
                variant="secondary"
                disabled={attempt.refresh === "pending"}
                onPress={control.refresh}
              />
            </>
          ) : null}
          {attempt.kind === "confirmed" &&
          attempt.refresh === "done" &&
          result?.outcome !== "applied" ? (
            <AppButton
              label="Review current output"
              variant="secondary"
              onPress={control.dismiss}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
