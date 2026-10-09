import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { clearStoredRundownPin, setStoredRundownPin } from "@/lib/rundown-pin";
import { getMobileRundown, type MobileRundown } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, useAppTheme } from "@/theme/tokens";

export function RundownUnlock({ orgId, showId, pinAccess }: {
  orgId: string;
  showId: string;
  pinAccess: MobileRundown["pinAccess"];
}) {
  const queryClient = useQueryClient();
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (pinAccess === "unprotected") return null;

  async function changeLock(unlock: boolean) {
    if (busy || (unlock && !pin.trim())) return;
    setBusy(true);
    setError(null);
    try {
      if (unlock) {
        await setStoredRundownPin(orgId, pin);
        // Validate before updating cached access or closing the prompt.
        const detail = await getMobileRundown(orgId, showId);
        if (detail.pinAccess !== "unlocked") {
          await clearStoredRundownPin(orgId);
          setError("Incorrect PIN. Please try again.");
          return;
        }
        queryClient.setQueryData(["mobile-rundown", orgId, showId], detail);
      } else {
        await clearStoredRundownPin(orgId);
        // Drop write controls and the old socket before waiting on the network.
        queryClient.setQueriesData<MobileRundown>({ queryKey: ["mobile-rundown", orgId] }, (detail) =>
          detail ? { ...detail, canEdit: false, canControl: false, pinAccess: "locked" } : detail);
      }
      // Refresh every cached show; the active screen reconnects its live socket.
      await queryClient.invalidateQueries({ queryKey: ["mobile-rundown", orgId] });
      setOpen(false);
      setPin("");
    } catch {
      setError("Could not update access. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return <View style={styles.container}>
    <AppButton variant="secondary" label={pinAccess === "unlocked" ? "Lock changes" : "Unlock changes"} disabled={busy}
      onPress={() => pinAccess === "unlocked" ? void changeLock(false) : setOpen(true)} />
    {!open && error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
      <Page title="Unlock changes" subtitle="Enter the organization PIN to edit the rundown and use live controls.">
        <TextInput accessibilityLabel="Rundown PIN" autoFocus secureTextEntry keyboardType="number-pad" autoCorrect={false}
          value={pin} onChangeText={setPin} placeholder="PIN" placeholderTextColor={colors.textFaint} style={styles.input} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <AppButton label={busy ? "Checking…" : "Unlock changes"} disabled={busy || !pin.trim()} onPress={() => void changeLock(true)} />
        <AppButton variant="secondary" label="Continue viewing" disabled={busy} onPress={() => setOpen(false)} />
      </Page>
    </Modal>
  </View>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  container: { gap: 10 },
  error: { color: colors.red, fontFamily, fontSize: 14 },
  input: { minHeight: 52, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 20, paddingHorizontal: 16 },
}));
