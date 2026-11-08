import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import X from "lucide-react-native/icons/x";
import { workspaceCopy } from "@showpilot/shared";
import { useTerms } from "@/providers/workspace-provider";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { useScreenFocus } from "@/hooks/use-screen-polling";
import { useRundownDetails } from "@/hooks/use-rundown-details";
import {
  readMobileRundownDetails,
  commandMobileRundownDetails,
} from "@/lib/mobile-api";
import { rundownDetailsFieldsSchema } from "@/lib/rundown-details-recovery";
import {
  createThemedStyles,
  fontFamily,
  spacing,
  useAppTheme,
} from "@/theme/tokens";
export function RundownShowSheet(props: {
  orgId: string;
  userId: string;
  showId: string;
  onClose: () => void;
}) {
  const styles = useStyles(),
    { colors } = useAppTheme(),
    terms = useTerms(),
    client = useQueryClient(),
    active = useScreenFocus();
  const [confirmation, setConfirmation] = useState<"load" | "discard" | null>(
    null,
  );
  useEffect(() => {
    if (!active) setConfirmation(null);
  }, [active]);
  const state = useRundownDetails(
    { orgId: props.orgId, userId: props.userId, showId: props.showId },
    {
      active,
      read: readMobileRundownDetails,
      send: commandMobileRundownDetails,
      refresh: async (signal) => {
        await Promise.all([
          client.invalidateQueries(
            { queryKey: ["mobile-rundown", props.orgId, props.showId, props.userId] },
            { throwOnError: true },
          ),
          client.invalidateQueries(
            { queryKey: ["mobile-schedule", props.orgId] },
            { throwOnError: true },
          ),
        ]);
        if (signal.aborted) throw new Error("Show refresh cancelled.");
      },
    },
  );
  const { draft, attempt } = state,
    fields = draft?.fields;
  const editable = active && !state.locked && !confirmation;
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const outcome = attempt?.kind === "confirmed" ? attempt.result.outcome : null;
  const outcomeText = {
    applied: "Rundown details saved.",
    superseded:
      "The original save succeeded. Another operator has since changed these details.",
    conflict:
      "The show changed after you reviewed it. Your draft was not saved. Load current details before saving again.",
    cancelled:
      "The original save was cancelled before it applied. Your draft is retained.",
    removed: "This show has been removed. Your retained draft is still here.",
  };
  function finish() {
    if (state.discard()) props.onClose();
  }
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible
    >
      <Page scroll={false}>
        <View style={styles.header}>
          <View style={styles.copy}>
            <Text style={styles.eyebrow}>RUNDOWN DETAILS</Text>
            <Text style={styles.title}>Title, time, and venue</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close show details"
            onPress={props.onClose}
            style={styles.close}
          >
            <X color={colors.textMuted} size={21} />
          </Pressable>
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>
            Closing keeps this draft and its original save while you remain
            signed in. Saved details synchronize with connected operators.
          </Text>
          {state.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {state.error}
            </Text>
          ) : null}
          {state.reading ? (
            <Text accessibilityLiveRegion="polite" style={styles.hint}>
              Loading current rundown details…
            </Text>
          ) : null}
          {!draft && !state.reading ? (
            <AppButton
              label="Retry loading details"
              disabled={!active}
              onPress={state.loadCurrent}
            />
          ) : null}
          {fields ? (
            <>
              <AppField
                label={workspaceCopy("Show or service title", terms)}
                autoCapitalize="sentences"
                maxLength={120}
                value={fields.name}
                editable={editable}
                onChangeText={(name) => state.setFields({ name })}
              />
              <AppField
                label="Start time"
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                placeholder="09:30"
                value={fields.startTime}
                editable={editable}
                onChangeText={(startTime) => state.setFields({ startTime })}
                error={
                  !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(fields.startTime)
                    ? "Use 24-hour HH:mm."
                    : undefined
                }
              />
              <AppField
                label="Crew call (optional)"
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                placeholder="08:00"
                value={fields.callTime}
                editable={editable}
                onChangeText={(callTime) => state.setFields({ callTime })}
                error={
                  !/^$|^([01]\d|2[0-3]):[0-5]\d$/.test(fields.callTime)
                    ? "Use 24-hour HH:mm."
                    : undefined
                }
              />
              <Text style={styles.hint}>
                Times use {fields.timeZone} on {fields.serviceDate}.
              </Text>
              <AppField
                label="Venue or location"
                autoCapitalize="words"
                maxLength={240}
                value={fields.location}
                editable={editable}
                onChangeText={(location) => state.setFields({ location })}
              />
              {!attempt ? (
                <AppButton
                  label="Save details"
                  disabled={
                    !editable ||
                    !rundownDetailsFieldsSchema.safeParse(fields).success
                  }
                  onPress={state.submit}
                />
              ) : null}
            </>
          ) : null}
          {attempt?.kind === "pending" ? (
            <Text accessibilityLiveRegion="polite" style={styles.hint}>
              Confirming the original details save…
            </Text>
          ) : null}
          {attempt?.kind === "failed" ? (
            <>
              <Text accessibilityRole="alert" style={styles.error}>
                {attempt.message} The save may already have applied. Retry sends
                the same request; Review checks it or cancels it before a
                delayed save can apply.
              </Text>
              <AppButton
                label="Retry original details save"
                disabled={!active}
                onPress={state.retry}
              />
              <AppButton
                label="Review original details save"
                variant="secondary"
                disabled={!active}
                onPress={state.review}
              />
            </>
          ) : null}
          {attempt?.kind === "confirmed" && outcome ? (
            <>
              <Text accessibilityLiveRegion="polite" style={styles.hint}>
                {outcomeText[outcome]}
              </Text>
              {attempt.refresh === "pending" ? (
                <Text style={styles.hint}>Refreshing the show…</Text>
              ) : null}
              {attempt.refresh === "idle" || attempt.refresh === "failed" ? (
                <>
                  <Text accessibilityRole="alert" style={styles.error}>
                    {attempt.message ?? "Refresh the show to finish."} The
                    result above is confirmed.
                  </Text>
                  <AppButton
                    label="Refresh show only"
                    disabled={!active}
                    onPress={state.refresh}
                  />
                </>
              ) : null}
              {settled && ["applied", "superseded"].includes(outcome) ? (
                <AppButton
                  label="Finish details change"
                  disabled={!active || !!confirmation}
                  onPress={finish}
                />
              ) : null}
              {settled && outcome === "cancelled" ? (
                <AppButton
                  label="Edit cancelled details"
                  disabled={!active || !!confirmation}
                  onPress={state.editCancelled}
                />
              ) : null}
            </>
          ) : null}
          {draft && active && !state.reading && (!attempt || settled) ? (
            <>
              {outcome !== "removed" ? (
                <AppButton
                  label="Load current details…"
                  variant="secondary"
                  disabled={!!confirmation}
                  onPress={() => setConfirmation("load")}
                />
              ) : null}
              <AppButton
                label="Discard details draft…"
                variant="secondary"
                disabled={!!confirmation}
                onPress={() => setConfirmation("discard")}
              />
            </>
          ) : null}
          {confirmation ? (
            <View style={styles.confirmation}>
              <Text style={styles.hint}>
                {confirmation === "load"
                  ? "Replace this retained draft with the current show details and revision? No change will be saved."
                  : "Discard this retained details draft? This does not undo a saved change."}
              </Text>
              <AppButton
                label={
                  confirmation === "load"
                    ? "Replace with current details"
                    : "Discard draft"
                }
                variant="danger"
                onPress={() => {
                  if (confirmation === "load") state.loadCurrent();
                  else finish();
                  setConfirmation(null);
                }}
              />
              <AppButton
                label="Keep draft"
                variant="secondary"
                onPress={() => setConfirmation(null)}
              />
            </View>
          ) : null}
        </ScrollView>
      </Page>
    </Modal>
  );
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    header: { flexDirection: "row", alignItems: "center", gap: 12 },
    copy: { flex: 1, minWidth: 0, gap: 4 },
    eyebrow: {
      color: colors.amberText,
      fontFamily,
      fontSize: 11,
      fontWeight: "900",
    },
    title: { color: colors.text, fontFamily, fontSize: 21, fontWeight: "900" },
    close: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 13,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.panel,
    },
    content: { paddingTop: spacing.large, paddingBottom: 48, gap: 14 },
    hint: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
    error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
    confirmation: {
      gap: 12,
      paddingTop: 16,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
  }),
);
