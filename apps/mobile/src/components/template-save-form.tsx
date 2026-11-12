import { useEffect, useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { useScreenFocus } from "@/hooks/use-screen-polling";
import { useTemplateSave } from "@/hooks/use-template-save";
import { commandMobileTemplateSave } from "@/lib/mobile-api";
import type { TemplateCopyInput } from "@/lib/template-save-recovery";
import { createThemedStyles, fontFamily } from "@/theme/tokens";
export function TemplateSaveForm(props: {
  orgId: string;
  userId: string;
  showId: string;
  copy: TemplateCopyInput;
  canCapture: boolean;
}) {
  const active = useScreenFocus(),
    client = useQueryClient(),
    styles = useStyles();
  const [confirm, setConfirm] = useState<"discard" | "copy" | null>(null);
  useEffect(() => {
    if (!active) setConfirm(null);
  }, [active]);
  const state = useTemplateSave(
    { orgId: props.orgId, userId: props.userId, showId: props.showId },
    props.copy,
    {
      active,
      send: commandMobileTemplateSave,
      refresh: async (signal) => {
        await client.invalidateQueries(
          {
            queryKey: [
              "mobile-rundown-templates",
              props.orgId,
              props.showId,
              props.userId,
            ],
          },
          { throwOnError: true },
        );
        if (signal.aborted) throw new Error("Template list refresh cancelled.");
      },
    },
  );
  const { draft, attempt } = state;
  if (!draft)
    return (
      <View style={styles.container}>
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error ?? "Preparing the reviewed copy…"}
        </Text>
        <AppButton
          label="Capture current rundown"
          disabled={!active || !props.canCapture}
          onPress={state.capture}
        />
      </View>
    );
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const outcome = attempt?.kind === "confirmed" ? attempt.result.outcome : null;
  const outcomeText = {
    applied: "Template saved.",
    cancelled:
      "The original save was cancelled before it applied. Your draft is retained.",
    conflict:
      "This save conflicts with an existing template. Review the list before starting another save.",
    removed:
      "The saved template or source show was removed. This request will not recreate it.",
  };
  return (
    <View style={styles.container}>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      <Text style={styles.heading}>Save current rundown</Text>
      <Text style={styles.hint}>
        This reviewed copy has {draft.copy.items.length} item{draft.copy.items.length === 1 ? "" : "s"} from{" "}
        {draft.copy.serviceName || "Untitled show"}
        {draft.copy.scheduledStartTime
          ? ` at ${draft.copy.scheduledStartTime}`
          : ""}
        . Later live changes do not alter it.
      </Text>
      <Text style={styles.hint}>
        Closing keeps this draft and its original save while you remain signed
        in.
      </Text>
      <AppField
        label="Template name"
        maxLength={200}
        value={draft.name}
        editable={active && !state.locked && !confirm}
        onChangeText={state.setName}
      />
      {!attempt && !confirm ? (
        <>
          <AppButton
            label="Save template"
            disabled={!active || !draft.name.trim()}
            onPress={state.submit}
          />
          <AppButton
            label="Use current rundown…"
            variant="secondary"
            disabled={!active || !props.canCapture}
            onPress={() => setConfirm("copy")}
          />
          <AppButton
            label="Discard template draft…"
            variant="secondary"
            disabled={!active}
            onPress={() => setConfirm("discard")}
          />
        </>
      ) : null}
      {attempt?.kind === "pending" ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>
          Confirming the original template save…
        </Text>
      ) : null}
      {attempt?.kind === "failed" ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {attempt.message}
          </Text>
          <AppButton
            label="Retry original template save"
            disabled={!active}
            onPress={state.retry}
          />
          <AppButton
            label="Review original template save"
            variant="secondary"
            disabled={!active}
            onPress={state.review}
          />
        </>
      ) : null}
      {outcome ? (
        <Text accessibilityLiveRegion="polite" style={styles.hint}>
          {outcomeText[outcome]}
        </Text>
      ) : null}
      {attempt?.kind === "confirmed" && attempt.refresh !== "done" ? (
        <>
          <Text
            accessibilityRole={
              attempt.refresh === "failed" ? "alert" : undefined
            }
            style={attempt.refresh === "failed" ? styles.error : styles.hint}
          >
            {attempt.message ?? "Refreshing saved templates…"} The save result
            above is confirmed.
          </Text>
          <AppButton
            label="Refresh templates only"
            loading={attempt.refresh === "pending"}
            disabled={!active || attempt.refresh === "pending"}
            onPress={state.refresh}
          />
        </>
      ) : null}
      {settled ? (
        <>
          {outcome === "cancelled" ? (
            <AppButton
              label="Edit cancelled template save"
              disabled={!active}
              onPress={state.editCancelled}
            />
          ) : (
            <AppButton
              label="Finish template save"
              disabled={!active}
              onPress={state.clear}
            />
          )}
        </>
      ) : null}
      {confirm ? (
        <View style={styles.container}>
          <Text style={styles.hint}>
            {confirm === "copy"
              ? "Replace this reviewed copy with the current rundown on this screen? Your template name will stay."
              : "Discard this unsent template draft?"}
          </Text>
          <AppButton
            label="Keep draft"
            variant="secondary"
            onPress={() => setConfirm(null)}
          />
          <AppButton
            label={
              confirm === "copy" ? "Replace reviewed copy" : "Discard draft"
            }
            disabled={!active || (confirm === "copy" && !props.canCapture)}
            onPress={() => {
              if (confirm === "copy") state.replaceCopy();
              else state.clear();
              setConfirm(null);
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    container: { gap: 12 },
    heading: {
      fontFamily,
      fontSize: 16,
      fontWeight: "800",
      color: colors.text,
    },
    hint: { fontFamily, fontSize: 14, lineHeight: 21, color: colors.textMuted },
    error: { fontFamily, fontSize: 14, lineHeight: 21, color: colors.red },
  }),
);
