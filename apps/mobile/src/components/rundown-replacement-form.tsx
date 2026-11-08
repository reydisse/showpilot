import { useState } from "react";
import { Text, View, StyleSheet } from "react-native";
import { AppButton } from "@/components/app-button";
import type { useRundownReplacement } from "@/hooks/use-rundown-replacement";
import { createThemedStyles, fontFamily } from "@/theme/tokens";
export function RundownReplacementForm({
  state,
  active,
  canReplace,
}: {
  state: ReturnType<typeof useRundownReplacement>;
  active: boolean;
  canReplace: boolean;
}) {
  const styles = useStyles(),
    [confirm, setConfirm] = useState<"refresh" | "discard" | null>(null);
  const { draft, attempt } = state,
    base = draft?.base;
  if (!draft) return null;
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const outcome = attempt?.kind === "confirmed" ? attempt.result.outcome : null;
  const messages = {
    applied: "The reviewed rundown replaced this show's items.",
    superseded:
      "The original replacement succeeded. The show has since changed; retry did not replace it again.",
    cancelled: "The original replacement was cancelled before it applied.",
    conflict:
      "The show changed or was not stopped. The reviewed replacement was not applied.",
    removed: "This show was removed. The replacement was not recreated.",
  };
  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Replace current rundown?</Text>
      <Text style={styles.text}>
        Closing keeps the reviewed copy and any original request while you
        remain signed in.
      </Text>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {state.reading ? (
        <Text style={styles.text}>Loading the source and current show…</Text>
      ) : null}
      {!base && !state.reading ? (
        <AppButton
          label="Retry loading replacement"
          disabled={!active}
          onPress={state.loadCurrent}
        />
      ) : null}
      {base ? (
        <>
          <Text style={styles.text}>
            Replace all items in {base.targetName || "Untitled show"} with{" "}
            {base.copy.items.length} item
            {base.copy.items.length === 1 ? "" : "s"} from{" "}
            {base.label || "Untitled source"}. This resets item timing and the
            timer. The copied show title, start time and venue are shown below.
          </Text>
          <Text style={styles.text}>
            Title: {base.copy.serviceName || "Untitled show"}
            {"\n"}Start:{" "}
            {base.copy.scheduledStartTime
              ? new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: base.timeZone,
                }).format(new Date(base.copy.scheduledStartTime))
              : "Not set"}{" "}
            ({base.timeZone}){"\n"}Venue: {base.copy.location || "Not set"}
          </Text>
          {!base.canReplace ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Stop the show, then review the current copy before replacing it.
            </Text>
          ) : null}
          {!attempt && !confirm ? (
            <AppButton
              label="Confirm rundown replacement"
              disabled={
                !active || !canReplace || !base.canReplace || state.reading
              }
              onPress={state.submit}
            />
          ) : null}
        </>
      ) : null}
      {attempt?.kind === "pending" ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          Confirming the original replacement…
        </Text>
      ) : null}
      {attempt?.kind === "failed" ? (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {attempt.message}
          </Text>
          <AppButton
            label="Retry original replacement"
            disabled={!active}
            onPress={state.retry}
          />
          <AppButton
            label="Review original replacement"
            variant="secondary"
            disabled={!active}
            onPress={state.review}
          />
        </>
      ) : null}
      {outcome ? (
        <Text accessibilityLiveRegion="polite" style={styles.text}>
          {messages[outcome]}
        </Text>
      ) : null}
      {attempt?.kind === "confirmed" && !settled ? (
        <>
          <Text
            accessibilityRole={
              attempt.refresh === "failed" ? "alert" : undefined
            }
            style={styles.text}
          >
            {attempt.message ?? "Refreshing the show…"} The replacement result
            above is confirmed.
          </Text>
          <AppButton
            label="Refresh show only"
            loading={attempt.refresh === "pending"}
            disabled={!active || attempt.refresh === "pending"}
            onPress={state.refresh}
          />
        </>
      ) : null}
      {(!attempt || settled) && !state.reading ? (
        <>
          {base && !confirm ? (
            <AppButton
              label="Review current copy…"
              variant="secondary"
              disabled={!active}
              onPress={() => setConfirm("refresh")}
            />
          ) : null}
          {!confirm ? (
            <AppButton
              label={settled ? "Finish replacement" : "Discard replacement…"}
              variant="secondary"
              disabled={!active}
              onPress={() =>
                settled ? state.discard() : setConfirm("discard")
              }
            />
          ) : null}
        </>
      ) : null}
      {confirm ? (
        <>
          <Text style={styles.text}>
            {confirm === "refresh"
              ? "Replace this reviewed copy with the source and target as they are now?"
              : "Discard this unsent replacement?"}
          </Text>
          <AppButton
            label="Keep reviewed copy"
            variant="secondary"
            onPress={() => setConfirm(null)}
          />
          <AppButton
            label={
              confirm === "refresh"
                ? "Load current replacement"
                : "Discard replacement"
            }
            disabled={!active || (state.locked && !settled)}
            onPress={() => {
              if (confirm === "refresh") state.loadCurrent();
              else state.discard();
              setConfirm(null);
            }}
          />
        </>
      ) : null}
    </View>
  );
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    container: {
      gap: 12,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 12,
      padding: 16,
    },
    heading: {
      fontFamily,
      fontSize: 18,
      fontWeight: "800",
      color: colors.text,
    },
    text: { fontFamily, fontSize: 14, lineHeight: 21, color: colors.textMuted },
    error: { fontFamily, fontSize: 14, lineHeight: 21, color: colors.red },
  }),
);
