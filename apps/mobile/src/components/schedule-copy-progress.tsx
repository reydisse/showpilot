import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { createThemedStyles, fontFamily, radii } from "@/theme/tokens";
import { reminderMessage } from "../lib/reminder-recovery";
import {
  copyTeamBlockedMessage,
  type CopyTeamSelection,
} from "../lib/copy-recovery";
import { copyRetryable, type useMobileCopy } from "../hooks/use-mobile-copy";

export function ScheduleCopyProgress({
  copies,
  canCopyAgain,
  onCopyAgain,
}: {
  copies: ReturnType<typeof useMobileCopy>;
  canCopyAgain: (selection: CopyTeamSelection) => boolean;
  onCopyAgain: (slot: string) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.list}>
      {Object.entries(copies.work).map(([slot, attempt]) => {
        const result =
          attempt.kind === "confirmed" ? attempt.result : attempt.previous;
        return (
          <View key={slot} accessibilityLiveRegion="polite" style={styles.card}>
            <Text style={styles.title}>{attempt.label}</Text>
            {attempt.kind === "pending" ? (
              <Text style={styles.copy}>
                Checking team copy… You can leave this screen and return to
                check the result.
              </Text>
            ) : null}
            {attempt.kind === "failed" ? (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {attempt.message}
                </Text>
                <Text style={styles.copy}>
                  Some positions and invitations may already be saved. Retry
                  checks the original copy without adding positions again.
                </Text>
                <AppButton
                  label="Retry team copy"
                  onPress={() => copies.retry(slot)}
                />
              </>
            ) : null}
            {result ? (
              <>
                {attempt.kind !== "confirmed" ? (
                  <Text style={styles.copy}>Previous confirmed result:</Text>
                ) : null}
                {result.reason ? (
                  <Text accessibilityRole="alert" style={styles.error}>
                    {copyTeamBlockedMessage(result.reason)}
                  </Text>
                ) : (
                  <>
                    <Text style={styles.copy}>
                      The original copy added {result.copied} position
                      {result.copied === 1 ? "" : "s"}. Current results:
                    </Text>
                    {result.items.map((item) => (
                      <View key={item.id} style={styles.item}>
                        <Text style={styles.itemName}>{item.label}</Text>
                        <Text style={styles.copy}>
                          {item.changed
                            ? "This position changed or was removed. The copy left it as it is."
                            : item.invitation
                              ? reminderMessage(item.invitation, "invitation")
                              : "Open position copied; no invitation needed."}
                        </Text>
                      </View>
                    ))}
                  </>
                )}
              </>
            ) : null}
            {attempt.kind === "confirmed" ? (
              <>
                <Text style={styles.copy}>
                  Last checked: {new Date(attempt.at).toLocaleString()}
                </Text>
                {attempt.refresh === "pending" ? (
                  <Text style={styles.copy}>
                    Copy checked. Refreshing Schedule…
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
                      The copy result is saved. Refresh Schedule to see current
                      positions; this does not copy or send invitations again.
                    </Text>
                    <AppButton
                      label="Refresh copied team"
                      onPress={() => copies.refresh(slot)}
                    />
                  </>
                ) : null}
                {attempt.refresh === "done" ? (
                  copyRetryable(attempt.result) ? (
                    <AppButton
                      label="Retry team copy"
                      onPress={() => copies.retry(slot)}
                    />
                  ) : (
                    <>
                      <Text style={styles.copy}>
                        Review both shows before a new copy. Earlier invitations
                        may already have arrived.
                      </Text>
                      {!canCopyAgain(attempt.command) ? (
                        <Text style={styles.copy}>
                          Open the original dates and check that the destination
                          is empty and stopped before copying again.
                        </Text>
                      ) : null}
                      <AppButton
                        disabled={!canCopyAgain(attempt.command)}
                        label="Review and copy again"
                        onPress={() => onCopyAgain(slot)}
                      />
                      <AppButton
                        variant="secondary"
                        label="Dismiss copy result"
                        onPress={() => copies.dismiss(slot)}
                      />
                    </>
                  )
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
