import { useState } from "react";
import Check from "lucide-react-native/icons/check";
import X from "lucide-react-native/icons/x";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import { createLocalRequestId } from "@/lib/request-id";
import { isServiceDate } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export interface RundownNewShowDraft {
  requestId: string;
  serviceDate: string;
  name: string;
  startTime: string;
  callTime: string;
  location: string;
  copyCurrent: boolean;
}

export function nextShowStartTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return "10:00";
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return "10:00";
  const next = Math.min(hours * 60 + minutes + 60, 23 * 60 + 59);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

export function RundownNewShowSheet({
  canCopyCurrent,
  currentDate,
  currentLocation,
  currentStartTime,
  onClose,
  onCreate,
}: {
  canCopyCurrent: boolean;
  currentDate: string;
  currentLocation: string;
  currentStartTime: string;
  onClose: () => void;
  onCreate: (draft: RundownNewShowDraft) => Promise<void>;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [requestId] = useState(() => createLocalRequestId("show"));
  const [name, setName] = useState("");
  const [serviceDate, setServiceDate] = useState(currentDate);
  const [startTime, setStartTime] = useState(() => nextShowStartTime(currentStartTime));
  const [callTime, setCallTime] = useState("");
  const [location, setLocation] = useState(currentLocation);
  const [copyCurrent, setCopyCurrent] = useState(canCopyCurrent);
  const [busy, setBusy] = useState(false);
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime);
  const valid = isServiceDate(serviceDate) && name.trim().length > 0 && validTime;

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <Page scroll={false}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>NEW SHOW</Text>
            <Text style={styles.heading}>Add another show</Text>
          </View>
          <Pressable accessibilityLabel="Close new show" accessibilityRole="button" disabled={busy} onPress={onClose} style={styles.close}>
            <X color={colors.textMuted} size={21} />
          </Pressable>
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.intro}>Create another show without leaving the rundown. Same-day shows stay separate across mobile, web, and desktop.</Text>
          <AppField autoCapitalize="sentences" label="Show name" maxLength={120} onChangeText={setName} placeholder="Evening service" value={name} />
          <AppField autoCapitalize="none" error={serviceDate && !isServiceDate(serviceDate) ? "Use YYYY-MM-DD." : undefined} keyboardType="numbers-and-punctuation" label="Date" maxLength={10} onChangeText={setServiceDate} placeholder="2026-09-07" value={serviceDate} />
          <AppField autoCapitalize="none" error={startTime && !validTime ? "Use 24-hour HH:mm." : undefined} keyboardType="numbers-and-punctuation" label="Start time" maxLength={5} onChangeText={setStartTime} placeholder="20:00" value={startTime} />
          <AppField autoCapitalize="none" keyboardType="numbers-and-punctuation" label="Crew call (optional)" maxLength={5} onChangeText={setCallTime} placeholder="18:30" value={callTime} />
          <AppField autoCapitalize="words" label="Venue or location" maxLength={240} onChangeText={setLocation} placeholder="Main auditorium" value={location} />
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: copyCurrent, disabled: !canCopyCurrent }}
            disabled={!canCopyCurrent}
            onPress={() => setCopyCurrent((current) => !current)}
            style={[styles.copyChoice, copyCurrent && styles.copyChoiceActive, !canCopyCurrent && styles.disabled]}
          >
            <View style={[styles.checkbox, copyCurrent && styles.checkboxActive]}>
              {copyCurrent ? <Check color={colors.black} size={14} strokeWidth={3} /> : null}
            </View>
            <View style={styles.copyText}>
              <Text style={styles.copyTitle}>Copy the current rundown</Text>
              <Text style={styles.copyHint}>Bring every rundown item into this new show.</Text>
            </View>
          </Pressable>
          <AppButton
            disabled={!valid || busy}
            label={busy ? "Creating show…" : "Create and open show"}
            loading={busy}
            onPress={() => {
              setBusy(true);
              void onCreate({
                requestId,
                serviceDate,
                name: name.trim(),
                startTime,
                callTime,
                location: location.trim(),
                copyCurrent,
              }).then(onClose).catch((error: unknown) => {
                Alert.alert("Show not created", error instanceof Error ? error.message : "Try again.");
              }).finally(() => setBusy(false));
            }}
          />
        </ScrollView>
      </Page>
    </Modal>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: spacing.medium, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0, gap: 5 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  heading: { color: colors.text, fontFamily, fontSize: 22, lineHeight: 28, fontWeight: "800" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.large, paddingVertical: spacing.large, paddingBottom: 60 },
  intro: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20 },
  copyChoice: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 12 },
  copyChoiceActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  checkbox: { width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised },
  checkboxActive: { borderColor: colors.amber, backgroundColor: colors.amber },
  copyText: { flex: 1, minWidth: 0, gap: 3 },
  copyTitle: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  copyHint: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 16 },
  disabled: { opacity: 0.4 },
}));
