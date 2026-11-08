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
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { useScreenFocus } from "@/hooks/use-screen-polling";
import { useScheduleProvider } from "@/hooks/use-schedule-provider";
import {
  readMobileScheduleProvider,
  commandMobileScheduleProvider,
} from "@/lib/mobile-api";
import {
  scheduleProviderConfigSchema,
  scheduleProviderLabel,
} from "@/lib/schedule-provider-recovery";
import {
  createThemedStyles,
  fontFamily,
  spacing,
  useAppTheme,
} from "@/theme/tokens";
export function ScheduleProviderSheet(props: {
  orgId: string;
  userId: string;
  onClose: () => void;
}) {
  const styles = useStyles(),
    { colors } = useAppTheme(),
    client = useQueryClient(),
    active = useScreenFocus();
  const [confirmation, setConfirmation] = useState<"load" | "discard" | null>(
    null,
  );
  useEffect(() => {
    if (!active) setConfirmation(null);
  }, [active]);
  const state = useScheduleProvider(props, {
    active,
    read: readMobileScheduleProvider,
    send: commandMobileScheduleProvider,
    refresh: async (signal) => {
      await Promise.all([
        client.invalidateQueries(
          { queryKey: ["mobile-schedule", props.orgId] },
          { throwOnError: true },
        ),
        client.invalidateQueries(
          { queryKey: ["mobile-bootstrap", props.userId, props.orgId] },
          { throwOnError: true },
        ),
      ]);
      if (signal.aborted) throw new Error("Schedule refresh cancelled.");
    },
  });
  const { draft, attempt } = state;
  const editable = active && !state.locked && !confirmation;
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const finished =
    attempt?.kind === "confirmed" && attempt.result.outcome !== "conflict";
  const fields = draft?.fields;
  const parsed =
    fields &&
    scheduleProviderConfigSchema.safeParse({
      provider: fields.provider,
      url: fields.provider === "native" ? "" : fields.url,
      label: fields.provider === "other" ? fields.label : "",
    });
  const canReplace = active && !state.reading && (!attempt || settled);
  function closeFinished() {
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
            <Text style={styles.eyebrow}>SCHEDULING SOURCE</Text>
            <Text style={styles.title}>Schedule settings</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close Schedule settings"
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
            Closing keeps your draft and any unconfirmed save on this device
            while you remain signed in.
          </Text>
          {state.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {state.error}
            </Text>
          ) : null}
          {state.reading ? (
            <Text accessibilityLiveRegion="polite" style={styles.hint}>
              Loading the current scheduling source…
            </Text>
          ) : null}
          {!draft && !state.reading ? (
            <AppButton
              label="Retry loading source"
              onPress={state.loadCurrent}
              disabled={!active}
            />
          ) : null}
          {draft && fields ? (
            <>
              <Text style={styles.hint}>
                Reviewed source: {scheduleProviderLabel(draft.base.config)}
              </Text>
              <Text style={styles.label}>SOURCE</Text>
              <View style={styles.options}>
                {(
                  [
                    ["native", "ShowPilot"],
                    ["planning-center", "Planning Center"],
                    ["faithteams", "Faith Teams"],
                    ["other", "Other platform"],
                  ] as const
                ).map(([value, title]) => (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityLabel={title}
                    accessibilityState={{
                      checked: fields.provider === value,
                      disabled: !editable,
                    }}
                    disabled={!editable}
                    onPress={() => state.setFields({ provider: value })}
                    style={[
                      styles.option,
                      fields.provider === value && styles.selected,
                    ]}
                  >
                    <Text style={styles.label}>{title}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.hint}>
                Organization language follows your workspace type. Change it in
                Settings → Workspace.
              </Text>
              {fields.provider === "other" ? (
                <AppField
                  editable={editable}
                  label="Platform name"
                  maxLength={80}
                  value={fields.label}
                  onChangeText={(label) => state.setFields({ label })}
                />
              ) : null}
              {fields.provider !== "native" ? (
                <AppField
                  editable={editable}
                  label="Scheduling workspace URL"
                  maxLength={500}
                  keyboardType="url"
                  autoCorrect={false}
                  value={fields.url}
                  onChangeText={(url) => state.setFields({ url })}
                  error={
                    fields.url && !parsed?.success
                      ? "Enter a valid HTTPS workspace URL."
                      : undefined
                  }
                />
              ) : null}
              {!attempt ? (
                <AppButton
                  label="Save schedule settings"
                  disabled={!editable || !parsed?.success}
                  onPress={state.submit}
                />
              ) : null}
              {attempt?.kind === "pending" ? (
                <Text accessibilityLiveRegion="polite" style={styles.hint}>
                  Confirming the original scheduling source change…
                </Text>
              ) : null}
              {attempt?.kind === "failed" ? (
                <>
                  <Text accessibilityRole="alert" style={styles.error}>
                    {attempt.message} The save may already have applied. Retry
                    keeps the original settings and request.
                  </Text>
                  <AppButton
                    label="Retry original source change"
                    onPress={state.retry}
                    disabled={!active}
                  />
                </>
              ) : null}
              {attempt?.kind === "confirmed" ? (
                <>
                  <Text accessibilityLiveRegion="polite" style={styles.hint}>
                    {attempt.result.outcome === "applied"
                      ? "Scheduling source saved."
                      : attempt.result.outcome === "superseded"
                        ? "Your source was saved before a later change. Load the current source before editing again."
                        : "The scheduling source changed before this save. Your draft was not applied."}
                  </Text>
                  <Text style={styles.hint}>
                    Source returned by the server:{" "}
                    {scheduleProviderLabel(attempt.result.snapshot.config)}
                  </Text>
                  {attempt.refresh === "pending" ? (
                    <Text style={styles.hint}>Refreshing Schedule…</Text>
                  ) : null}
                  {attempt.refresh === "failed" ||
                  attempt.refresh === "idle" ? (
                    <>
                      <Text accessibilityRole="alert" style={styles.error}>
                        {attempt.message ?? "Refresh Schedule to finish."} The
                        save outcome above is confirmed.
                      </Text>
                      <AppButton
                        label="Refresh Schedule only"
                        onPress={state.refresh}
                        disabled={!active}
                      />
                    </>
                  ) : null}
                  {settled && finished ? (
                    <AppButton
                      label="Finish source change"
                      onPress={closeFinished}
                      disabled={!active || !!confirmation}
                    />
                  ) : null}
                </>
              ) : null}
              {canReplace ? (
                <>
                  <AppButton
                    label="Load current source…"
                    variant="secondary"
                    disabled={!!confirmation}
                    onPress={() => setConfirmation("load")}
                  />
                  {!finished ? (
                    <AppButton
                      label="Discard source draft…"
                      variant="secondary"
                      disabled={!!confirmation}
                      onPress={() => setConfirmation("discard")}
                    />
                  ) : null}
                </>
              ) : null}
              {confirmation ? (
                <View style={styles.confirmation}>
                  <Text style={styles.hint}>
                    {confirmation === "load"
                      ? "Replace your retained draft with the current scheduling source? No change will be saved."
                      : "Discard this source draft? This does not undo a saved change."}
                  </Text>
                  <AppButton
                    label={
                      confirmation === "load"
                        ? "Replace with current source"
                        : "Discard draft"
                    }
                    variant="danger"
                    onPress={() => {
                      if (confirmation === "load") state.loadCurrent();
                      else closeFinished();
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
            </>
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
      letterSpacing: 1.2,
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
    label: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
    options: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    option: {
      minHeight: 44,
      padding: 12,
      justifyContent: "center",
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    selected: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
    confirmation: {
      gap: 12,
      paddingTop: 16,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
  }),
);
