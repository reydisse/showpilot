import { Modal, ScrollView, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";
import type { TimecodeClockDraft } from "../lib/timecode-clock-recovery";

export function TimecodeClockConfirmation({ review, showName, changed, active, onCancel, onReview, onConfirm }: {
  review: NonNullable<TimecodeClockDraft["review"]>; showName: string; changed: boolean; active: boolean;
  onCancel: () => void; onReview: () => void; onConfirm: () => void;
}) {
  const { colors } = useAppTheme();
  const { command } = review;
  const target = command.kind === "seek" ? [command.timecode.hours, command.timecode.minutes, command.timecode.seconds, command.timecode.frames].map(value => String(value).padStart(2, "0")).join(":")
    : `${command.format.frameRate} fps ${command.format.dropFrame.toUpperCase()}`;
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 };
  return <Modal visible transparent animationType="none" onRequestClose={onCancel}>
    <View style={{ flex: 1, backgroundColor: "#00000088", justifyContent: "center", padding: 16 }}>
      <ScrollView style={{ flexGrow: 0, maxHeight: "100%", width: "100%", maxWidth: 560, alignSelf: "center", backgroundColor: colors.panel, borderRadius: 14 }}>
        <View style={{ padding: 16, gap: 12 }}>
          <Text accessibilityRole="header" style={{ ...text, fontWeight: "800" }}>{command.kind === "seek" ? "Change clock position?" : "Reformat timeline?"}</Text>
          <Text style={text}>Show: {showName}</Text>
          <Text style={text}>{command.kind === "seek" ? `${review.from} → ${target}. This changes the shared clock for every operator. Large jumps pause automation for review; fired cues stay fired.`
            : `${command.expected.format.frameRate} fps ${command.expected.format.dropFrame.toUpperCase()} → ${target}. Cue frame positions are recalculated. Automation pauses and fired cues stay fired.`}</Text>
          {changed ? <><Text accessibilityRole="alert" style={text}>The show, clock position or format changed. Review the current clock before confirming.</Text><AppButton label="Review current clock" variant="secondary" disabled={!active} onPress={onReview} /></> : null}
          {!active ? <Text accessibilityRole="alert" style={text}>Connect, claim control and stop the source before confirming this change.</Text> : null}
          <AppButton label="Keep current clock" variant="secondary" onPress={onCancel} />
          <AppButton label={command.kind === "seek" ? "Confirm clock change" : "Confirm reformat"} variant="danger" disabled={!active || changed} onPress={onConfirm} />
        </View>
      </ScrollView>
    </View>
  </Modal>;
}
