import { useState } from "react";
import X from "lucide-react-native/icons/x";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { createLocalRequestId } from "@/lib/request-id";
import { serviceWallTimeInput } from "@/lib/service-time";
import { createThemedStyles, fontFamily, spacing, useAppTheme } from "@/theme/tokens";

export function RundownShowSheet({
  location: initialLocation,
  name: initialName,
  onClose,
  onSave,
  scheduledStartTime,
  timeZone,
}: {
  location: string;
  name: string;
  onClose: () => void;
  onSave: (draft: { requestId: string; name: string; startTime: string; location: string }) => Promise<void>;
  scheduledStartTime: string | null;
  timeZone: string;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [requestId] = useState(() => createLocalRequestId("show-meta"));
  const [name, setName] = useState(initialName);
  const [startTime, setStartTime] = useState(() => serviceWallTimeInput(scheduledStartTime, timeZone));
  const [location, setLocation] = useState(initialLocation);
  const [busy, setBusy] = useState(false);
  const validTime = /^$|^([01]\d|2[0-3]):[0-5]\d$/.test(startTime);

  return <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
    <Page scroll={false}>
      <View style={styles.header}>
        <View style={styles.headerCopy}><Text style={styles.eyebrow}>SHOW DETAILS</Text><Text style={styles.heading}>Title, time, and venue</Text></View>
        <Pressable accessibilityLabel="Close show details" accessibilityRole="button" onPress={onClose} style={styles.close}><X color={colors.textMuted} size={21} /></Pressable>
      </View>
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>These details synchronize with web, desktop, and every connected operator.</Text>
        <AppField autoCapitalize="sentences" label="Show or service title" maxLength={120} onChangeText={setName} placeholder="Sunday Morning" value={name} />
        <AppField autoCapitalize="none" error={!validTime ? "Use 24-hour HH:mm." : undefined} keyboardType="numbers-and-punctuation" label="Start time" maxLength={5} onChangeText={setStartTime} placeholder="09:30" value={startTime} />
        <AppField autoCapitalize="words" label="Venue or location" maxLength={240} onChangeText={setLocation} placeholder="Main auditorium" value={location} />
        <AppButton disabled={!validTime || busy} label={busy ? "Saving details…" : "Save details"} loading={busy} onPress={() => {
          setBusy(true);
          void onSave({ requestId, name: name.trim(), startTime, location: location.trim() })
            .then(onClose)
            .catch((error: unknown) => Alert.alert("Show details not saved", error instanceof Error ? error.message : "Try again."))
            .finally(() => setBusy(false));
        }} />
      </ScrollView>
    </Page>
  </Modal>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: spacing.medium, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0, gap: 5 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  heading: { color: colors.text, fontFamily, fontSize: 22, lineHeight: 28, fontWeight: "800" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.large, paddingVertical: spacing.large, paddingBottom: 60 },
  intro: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20 },
}));
