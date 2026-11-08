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
import { useShowManagement } from "@/hooks/use-show-management";
import {
  commandMobileShowManagement,
  readMobileManagedShow,
} from "@/lib/mobile-api";
import {
  showManagementFieldsSchema,
  type ShowManagementDraft,
  type ShowManagementReply,
} from "@/lib/show-management-recovery";
import {
  createThemedStyles,
  fontFamily,
  spacing,
  useAppTheme,
} from "@/theme/tokens";

export function ShowManagementSheet(props: {
  orgId: string;
  userId: string;
  initial: ShowManagementDraft;
  onClose: () => void;
}) {
  const styles = useStyles(),
    { colors } = useAppTheme();
  const client = useQueryClient(),
    active = useScreenFocus();
  const [confirmation, setConfirmation] = useState<
    "delete" | "discard" | "load" | null
  >(null);
  useEffect(() => {
    if (!active) setConfirmation(null);
  }, [active]);
  const state = useShowManagement(props, props.initial, {
    active,
    send: commandMobileShowManagement,
    read: readMobileManagedShow,
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
        client.invalidateQueries({
          queryKey: ["mobile-rundown", props.orgId, props.initial.showId],
          refetchType: "none",
        }),
      ]);
      if (signal.aborted) throw new Error("Show refresh cancelled.");
    },
  });
  const { draft, attempt } = state;
  const editing = draft.mode === "edit";
  const editable = editing && active && !state.locked && !confirmation;
  const valid =
    !editing || showManagementFieldsSchema.safeParse(draft.fields).success;
  const reply = attempt?.kind === "confirmed" ? attempt.result : null;
  const settled = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const finished =
    reply &&
    (reply.kind === "delete"
      ? reply.result.ok
      : ["applied", "superseded", "removed"].includes(reply.result.outcome));
  const canLoad =
    active &&
    !state.reading &&
    (!attempt || (settled && !(reply?.kind === "delete" && reply.result.ok)));
  function field(
    key: "name" | "startTime" | "callTime" | "location",
    value: string,
  ) {
    state.setDraft((current) => ({
      ...current,
      fields: { ...current.fields, [key]: value },
    }));
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
          <Text style={styles.title}>
            {editing ? "Edit show" : "Delete show"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close show change"
            onPress={props.onClose}
            style={styles.close}
          >
            <X color={colors.textMuted} size={21} />
          </Pressable>
        </View>
        <ScrollView
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          <Text style={styles.label}>
            {draft.base.name || "Untitled show"} · {draft.base.serviceDate}
          </Text>
          <Text style={styles.copy}>
            Your draft and original request stay available in Schedule for this
            signed-in app session.
          </Text>
          {draft.mode !== props.initial.mode ? (
            <Text style={styles.copy}>
              Your earlier {draft.mode === "edit" ? "edit" : "deletion request"}{" "}
              is retained. Finish or discard it before choosing another action
              for this show.
            </Text>
          ) : null}
          {editing ? (
            <>
              <Text style={styles.copy}>
                Times use {draft.fields.timeZone}. A newer edit on another
                device is protected.
              </Text>
              <AppField
                label="Show name"
                maxLength={120}
                value={draft.fields.name}
                editable={!!editable}
                onChangeText={(value) => field("name", value)}
                error={
                  !draft.fields.name.trim() ? "Enter a show name." : undefined
                }
              />
              <AppField
                label="Start time (optional)"
                maxLength={5}
                value={draft.fields.startTime}
                editable={!!editable}
                onChangeText={(value) => field("startTime", value)}
                error={
                  draft.fields.startTime &&
                  !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.fields.startTime)
                    ? "Use 24-hour HH:mm."
                    : undefined
                }
              />
              <AppField
                label="Crew call (optional)"
                maxLength={5}
                value={draft.fields.callTime}
                editable={!!editable}
                onChangeText={(value) => field("callTime", value)}
                error={
                  draft.fields.callTime &&
                  !/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.fields.callTime)
                    ? "Use 24-hour HH:mm."
                    : undefined
                }
              />
              <AppField
                label="Venue or location"
                maxLength={240}
                value={draft.fields.location}
                editable={!!editable}
                onChangeText={(value) => field("location", value)}
              />
            </>
          ) : (
            <Text style={styles.copy}>
              Deleting this show permanently removes its rundown, assignments,
              checklist, cues, and incidents. The show must be stopped. Its
              identity and reviewed version stay fixed if you retry.
            </Text>
          )}
          {state.error ? (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {state.error}
            </Text>
          ) : null}
          {state.reading ? (
            <Text accessibilityLiveRegion="polite" style={styles.copy}>
              Loading the current show… Your retained draft stays here if
              loading fails.
            </Text>
          ) : null}
          {attempt ? (
            <View accessibilityLiveRegion="polite" style={styles.progress}>
              {attempt.kind === "pending" ? (
                <Text style={styles.copy}>
                  Confirming the original {editing ? "save" : "deletion"}… You
                  can close and resume this request.
                </Text>
              ) : null}
              {attempt.kind === "failed" ? (
                <>
                  <Text style={styles.error}>{attempt.message}</Text>
                  {!editing ? (
                    <Text style={styles.copy}>
                      Deletion may already be accepted. Retry the same deletion
                      to finish cleanup. A different edit or delete cannot
                      replace this request.
                    </Text>
                  ) : null}
                  <AppButton
                    disabled={!active}
                    label={
                      editing
                        ? "Retry original save"
                        : "Retry original deletion"
                    }
                    onPress={state.retry}
                  />
                  {editing ? (
                    <>
                      <Text style={styles.copy}>
                        Review finds the original save or cancels it before a
                        delayed request can apply. Your draft stays here.
                      </Text>
                      <AppButton
                        disabled={!active}
                        variant="secondary"
                        label="Review original save"
                        onPress={state.reviewOriginal}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
              {attempt.kind === "confirmed" ? (
                <>
                  <Text style={styles.copy}>
                    {resultMessage(attempt.result)}
                  </Text>
                  {attempt.refresh === "pending" ? (
                    <Text style={styles.copy}>Refreshing Schedule…</Text>
                  ) : null}
                  {attempt.refresh === "failed" ||
                  attempt.refresh === "idle" ? (
                    <>
                      <Text style={styles.error}>
                        {attempt.message ?? "Refresh Schedule to finish."} The
                        change outcome above is confirmed.
                      </Text>
                      <AppButton
                        disabled={!active}
                        label="Refresh only"
                        onPress={state.refresh}
                      />
                    </>
                  ) : null}
                  {settled &&
                  reply?.kind === "edit" &&
                  reply.result.outcome === "cancelled" ? (
                    <AppButton
                      disabled={!active || state.reading || !!confirmation}
                      label="Edit unapplied draft"
                      onPress={state.editUnapplied}
                    />
                  ) : null}
                  {settled && finished ? (
                    <AppButton
                      disabled={!active || state.reading || !!confirmation}
                      label="Finish"
                      onPress={() => {
                        if (state.finish()) props.onClose();
                      }}
                    />
                  ) : null}
                </>
              ) : null}
            </View>
          ) : (
            <AppButton
              variant={editing ? "primary" : "danger"}
              disabled={!active || state.locked || !valid || !!confirmation}
              label={editing ? "Save show" : "Delete show…"}
              onPress={() => {
                if (editing) state.submit();
                else setConfirmation("delete");
              }}
            />
          )}
          {canLoad ? (
            <AppButton
              variant="secondary"
              disabled={!!confirmation}
              label={
                state.error
                  ? "Retry loading current show"
                  : "Load current show…"
              }
              onPress={() => setConfirmation("load")}
            />
          ) : null}
          {!state.locked || (settled && !finished && !state.reading) ? (
            <AppButton
              variant="secondary"
              disabled={!active || !!confirmation}
              label="Discard retained draft…"
              onPress={() => setConfirmation("discard")}
            />
          ) : null}
          {confirmation === "delete" ? (
            <View style={styles.progress}>
              <Text style={styles.error}>
                Delete {draft.base.name || "Untitled show"} on{" "}
                {draft.base.serviceDate} and all of its show data? This cannot
                be undone.
              </Text>
              <AppButton
                disabled={!active || state.locked}
                variant="danger"
                label="Delete reviewed show"
                onPress={() => {
                  setConfirmation(null);
                  state.submit();
                }}
              />
              <AppButton
                variant="secondary"
                label="Keep show"
                onPress={() => setConfirmation(null)}
              />
            </View>
          ) : null}
          {confirmation === "discard" ? (
            <View style={styles.progress}>
              <Text style={styles.copy}>
                Discard this retained draft and close the form? This does not
                undo a confirmed server change.
              </Text>
              <AppButton
                disabled={!active || state.reading}
                variant="danger"
                label="Discard draft"
                onPress={() => {
                  if (attempt ? state.finish() : state.discard())
                    props.onClose();
                }}
              />
              <AppButton
                variant="secondary"
                label="Keep draft"
                onPress={() => setConfirmation(null)}
              />
            </View>
          ) : null}
          {confirmation === "load" ? (
            <View style={styles.progress}>
              <Text style={styles.copy}>
                Replace these retained fields and the reviewed version with the
                current show? No change will be sent.
              </Text>
              <AppButton
                disabled={!canLoad}
                label="Load current and replace draft"
                onPress={() => {
                  setConfirmation(null);
                  state.loadCurrent();
                }}
              />
              <AppButton
                variant="secondary"
                label="Keep draft"
                onPress={() => setConfirmation(null)}
              />
            </View>
          ) : null}
        </ScrollView>
      </Page>
    </Modal>
  );
}
function resultMessage(reply: ShowManagementReply) {
  if (reply.kind === "delete")
    return reply.result.ok
      ? "Show deleted. Cleanup is complete."
      : `Deletion was not accepted. ${reply.result.message}`;
  switch (reply.result.outcome) {
    case "applied":
      return "Show details saved. Saving again is disabled.";
    case "superseded":
      return "Your save applied before a later change. Load the current show to review its latest details.";
    case "conflict":
      return "This show changed on another device. Your draft is retained. Load the current show before reviewing another save.";
    case "cancelled":
      return "The original save was cancelled before applying. You can safely edit the retained draft.";
    case "removed":
      return "This show was removed. Your original request will not recreate it.";
  }
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    header: { flexDirection: "row", alignItems: "center", gap: spacing.medium },
    title: {
      flex: 1,
      color: colors.text,
      fontFamily,
      fontSize: 22,
      fontWeight: "800",
    },
    close: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      width: "100%",
      maxWidth: 620,
      alignSelf: "center",
      gap: spacing.medium,
      paddingVertical: spacing.large,
      paddingBottom: 60,
    },
    copy: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
    label: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
    error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
    progress: { gap: spacing.medium },
  }),
);
