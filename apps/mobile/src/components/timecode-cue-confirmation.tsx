import { Modal, ScrollView, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";
import { cueControlLabels, type MobileCueControlReview } from "../lib/timecode-cue-control-recovery";
export function TimecodeCueConfirmation({ review, showName, changed, active, error, onCancel, onReview, onConfirm }: {
  review: MobileCueControlReview; showName: string; changed: boolean; active: boolean; error: string | null;
  onCancel: () => void; onReview: () => void; onConfirm: () => void;
}) {
  const { colors } = useAppTheme();
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 };
  return <Modal visible transparent animationType="none" onRequestClose={onCancel}>
    <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "center", padding: 16 }}>
      <ScrollView style={{ flexGrow: 0, maxHeight: "100%", width: "100%", maxWidth: 560, alignSelf: "center", backgroundColor: colors.panel, borderRadius: 14 }}>
        <View style={{ padding: 16, gap: 12 }}>
          <Text accessibilityRole="header" style={{ ...text, fontWeight: "800" }}>{cueControlLabels[review.command.operation]}?</Text>
          <Text style={text}>Show: {showName}</Text>
          <Text style={text}>{review.label}</Text>
          <Text style={text}>{review.detail}</Text>
          {changed ? <><Text accessibilityRole="alert" style={text}>The cue, timeline, clock or automation state changed. Review the current state before confirming.</Text><AppButton label="Review current cues" variant="secondary" disabled={!active} onPress={onReview} /></> : null}
          {error ? <Text accessibilityRole="alert" style={text}>{error}</Text> : null}
          {!active ? <Text accessibilityRole="alert" style={text}>Connect and claim control before confirming.</Text> : null}
          <AppButton label="Keep current cues" variant="secondary" onPress={onCancel} />
          <AppButton label={`Confirm ${cueControlLabels[review.command.operation].toLowerCase()}`} variant="danger" disabled={!active || changed} onPress={onConfirm} />
        </View>
      </ScrollView>
    </View>
  </Modal>;
}
