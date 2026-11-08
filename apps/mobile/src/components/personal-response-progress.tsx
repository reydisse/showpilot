import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { AppField } from "./app-field";
import { createThemedStyles, fontFamily, radii } from "@/theme/tokens";
import {
  personalResponseMessage,
  type ResponseSelection,
} from "../lib/personal-response-recovery";
import type { usePersonalResponses } from "../hooks/use-personal-responses";
export function PersonalResponseProgress({
  responses,
  latest,
}: {
  responses: ReturnType<typeof usePersonalResponses>;
  latest: (id: string) => ResponseSelection | null;
}) {
  const styles = useStyles();
  const ids = [
    ...new Set([
      ...responses.drafts.map((draft) => draft.assignmentId),
      ...Object.keys(responses.work),
    ]),
  ];
  return (
    <View style={styles.list}>
      {ids.map((id) => (
        <ResponseCard
          key={id}
          id={id}
          responses={responses}
          latest={latest(id)}
        />
      ))}
    </View>
  );
}
function ResponseCard({
  id,
  responses,
  latest,
}: {
  id: string;
  responses: ReturnType<typeof usePersonalResponses>;
  latest: ResponseSelection | null;
}) {
  const styles = useStyles(),
    [confirm, setConfirm] = useState<"discard" | "latest" | null>(null);
  const draft = responses.drafts.find((value) => value.assignmentId === id),
    attempt = responses.work[id];
  const ready = attempt?.kind === "confirmed" && attempt.refresh === "done";
  const active = responses.active;
  useEffect(() => {
    if (!active) setConfirm(null);
  }, [active]);
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text style={styles.title}>{attempt?.label ?? draft?.label}</Text>
      <Text style={styles.copy}>
        Your note and original request stay here for this signed-in app session.
      </Text>
      {draft ? (
        <AppField
          label={`Reason for declining ${draft.label}`}
          multiline
          maxLength={500}
          value={draft.reason}
          editable={active && !attempt && !confirm}
          onChangeText={(reason) => responses.setReason(id, reason)}
        />
      ) : null}
      {!attempt && draft ? (
        <>
          <AppButton
            disabled={!active || !!confirm || draft.reason.length > 500}
            label="Confirm decline"
            onPress={() => responses.submitDecline(id)}
          />
          <AppButton
            disabled={!active || !!confirm}
            variant="secondary"
            label="Discard response draft…"
            onPress={() => setConfirm("discard")}
          />
        </>
      ) : null}
      {attempt?.kind === "pending" ? (
        <Text style={styles.copy}>
          Confirming your response… You can leave this screen and return.
        </Text>
      ) : null}
      {attempt?.kind === "failed" ? (
        <>
          <Text style={styles.error} accessibilityRole="alert">
            {attempt.message}
          </Text>
          <Text style={styles.copy}>
            It may already have saved. Retry sends the same response. Review
            checks it or cancels it before a delayed request can apply.
          </Text>
          <AppButton
            disabled={!active}
            label="Retry original response"
            onPress={() => responses.retry(id)}
          />
          <AppButton
            disabled={!active}
            variant="secondary"
            label="Review original response"
            onPress={() => responses.review(id)}
          />
        </>
      ) : null}
      {attempt?.kind === "confirmed" ? (
        <>
          <Text style={styles.copy}>
            {personalResponseMessage(attempt.result)}
          </Text>
          {attempt.refresh === "pending" ? (
            <Text style={styles.copy}>Refreshing Schedule…</Text>
          ) : null}
          {attempt.refresh === "failed" || attempt.refresh === "idle" ? (
            <>
              <Text style={styles.error}>
                {attempt.message ?? "Refresh Schedule to finish."} Your response
                outcome above is confirmed.
              </Text>
              <AppButton
                disabled={!active}
                label="Refresh response status"
                onPress={() => responses.refresh(id)}
              />
            </>
          ) : null}
          {ready ? (
            <>
              {attempt.result.outcome === "cancelled" && draft ? (
                <AppButton
                  disabled={!active || !!confirm}
                  label="Edit cancelled response"
                  onPress={() => responses.editCancelled(id)}
                />
              ) : null}
              {draft &&
              latest &&
              ["conflict", "closed", "unavailable", "superseded"].includes(
                attempt.result.outcome,
              ) ? (
                <>
                  <Text style={styles.copy}>
                    Current assignment: {latest.label}. Your note will be kept.
                  </Text>
                  <AppButton
                    disabled={!active || !!confirm}
                    label="Review latest assignment…"
                    onPress={() => setConfirm("latest")}
                  />
                </>
              ) : null}
              <AppButton
                disabled={!active || !!confirm}
                variant="secondary"
                label={draft ? "Finish and discard note…" : "Finish response"}
                onPress={() =>
                  draft ? setConfirm("discard") : responses.finish(id)
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      {confirm ? (
        <View style={styles.list}>
          <Text style={styles.copy}>
            {confirm === "latest"
              ? "Use the current assignment details above and keep your note? This does not send a response."
              : "Discard this retained note and close its result? This does not undo a saved response."}
          </Text>
          <AppButton
            disabled={!active}
            label={
              confirm === "latest" ? "Use current assignment" : "Discard note"
            }
            onPress={() => {
              if (confirm === "latest" && latest)
                responses.reviewLatest(latest);
              else if (confirm === "discard") {
                if (attempt) responses.finish(id);
                else responses.discard(id);
              }
              setConfirm(null);
            }}
          />
          <AppButton
            variant="secondary"
            label="Keep note"
            onPress={() => setConfirm(null)}
          />
        </View>
      ) : null}
    </View>
  );
}
const useStyles = createThemedStyles((colors) =>
  StyleSheet.create({
    list: { gap: 12, minWidth: 0 },
    card: {
      gap: 10,
      minWidth: 0,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radii.medium,
      padding: 14,
      backgroundColor: colors.panel,
    },
    title: { fontFamily, fontSize: 16, fontWeight: "700", color: colors.text },
    copy: { fontFamily, fontSize: 14, lineHeight: 21, color: colors.textMuted },
    error: { fontFamily, fontSize: 14, lineHeight: 21, color: colors.red },
  }),
);
