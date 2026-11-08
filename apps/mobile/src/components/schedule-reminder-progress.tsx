import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { createThemedStyles, fontFamily, radii } from "@/theme/tokens";
import { reminderMessage, type ReminderTarget } from "../lib/reminder-recovery";
import {
  reminderRetryable,
  type useMobileReminders,
} from "../hooks/use-mobile-reminders";

export function ScheduleReminderProgress({
  reminders,
  canSendNew,
}: {
  reminders: ReturnType<typeof useMobileReminders>;
  canSendNew: (target: ReminderTarget) => boolean;
}) {
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {Object.entries(reminders.work).map(([slot, attempt]) => {
        const result =
          attempt.kind === "confirmed" ? attempt.result : attempt.previous;
        const retryable = result && reminderRetryable(result);
        const needsReview = result?.items.some(
          (item) => item.email === "expired" || item.email === "changed",
        );
        return (
          <View key={slot} accessibilityLiveRegion="polite" style={styles.card}>
            <Text style={styles.title}>{attempt.label}</Text>
            {attempt.kind === "pending" ? (
              <Text style={styles.copy}>
                Checking reminder delivery… You can leave this screen and return
                to check the result.
              </Text>
            ) : null}
            {attempt.kind === "failed" ? (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {attempt.message}
                </Text>
                <Text style={styles.copy}>
                  Some emails may already have been accepted. Retry checks this
                  request without repeating accepted emails.
                </Text>
                <AppButton
                  label="Retry reminders"
                  onPress={() => reminders.retry(slot)}
                />
              </>
            ) : null}
            {result ? (
              <>
                <Text style={styles.copy}>
                  {attempt.kind !== "confirmed"
                    ? "Previous confirmed result: "
                    : ""}
                  {result.items.length
                    ? `${result.items.filter((item) => item.email === "accepted").length} of ${result.items.length} emails accepted by the delivery service.`
                    : "No pending assignments in this selection."}
                </Text>
                {result.items.map((item) => (
                  <View key={item.id} style={styles.item}>
                    <Text style={styles.itemName}>{item.label}</Text>
                    <Text style={styles.copy}>{reminderMessage(item)}</Text>
                  </View>
                ))}
              </>
            ) : null}
            {attempt.kind === "confirmed" ? (
              <>
                <Text style={styles.copy}>
                  Last checked: {new Date(attempt.at).toLocaleString()}
                </Text>
                {attempt.refresh === "pending" ? (
                  <Text style={styles.copy}>
                    Delivery checked. Refreshing Schedule…
                  </Text>
                ) : null}
                {attempt.refresh === "idle" || attempt.refresh === "failed" ? (
                  <>
                    {attempt.message ? (
                      <Text accessibilityRole="alert" style={styles.error}>
                        {attempt.message}
                      </Text>
                    ) : null}
                    <Text style={styles.copy}>
                      Delivery was checked. Refresh Schedule to see the current
                      assignments; this does not send emails.
                    </Text>
                    <AppButton
                      label="Refresh schedule"
                      onPress={() => reminders.refresh(slot)}
                    />
                  </>
                ) : null}
                {attempt.refresh === "done" ? (
                  <>
                    {retryable ? (
                      <AppButton
                        label="Retry reminders"
                        onPress={() => reminders.retry(slot)}
                      />
                    ) : (
                      <>
                        {needsReview ? (
                          <Text style={styles.copy}>
                            Review the current assignments before sending again.
                            A previous email may already have arrived.
                          </Text>
                        ) : null}
                        {!canSendNew(attempt.command.target) ? (
                          <Text style={styles.copy}>
                            Open the original date and review pending
                            assignments before sending new reminders.
                          </Text>
                        ) : null}
                        <AppButton
                          disabled={!canSendNew(attempt.command.target)}
                          label={
                            needsReview
                              ? "Send new reminders after review"
                              : "Send another reminder"
                          }
                          onPress={() => reminders.another(slot)}
                        />
                        {!needsReview ? (
                          <AppButton
                            variant="secondary"
                            label="Dismiss result"
                            onPress={() => reminders.dismiss(slot)}
                          />
                        ) : null}
                      </>
                    )}
                  </>
                ) : null}
              </>
            ) : null}
          </View>
        );
      })}
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
    copy: { fontFamily, fontSize: 13, lineHeight: 20, color: colors.textMuted },
    error: { fontFamily, fontSize: 13, lineHeight: 20, color: colors.red },
    item: {
      gap: 3,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingTop: 8,
    },
    itemName: {
      fontFamily,
      fontSize: 13,
      lineHeight: 20,
      fontWeight: "700",
      color: colors.text,
    },
  }),
);
