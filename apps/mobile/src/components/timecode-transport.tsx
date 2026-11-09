import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import type { MobileTimecodeState } from "../lib/timecode-contract";
import { createThemedStyles, fontFamily } from "../theme/tokens";

type Props = {
  state?: MobileTimecodeState; connected: boolean; canStart: boolean; canStop: boolean;
  starting: boolean; stopping: boolean; stoppingAutomation: boolean;
  onStart: () => void; onStop: () => void; onStopAutomation: () => void;
};
/** Outside the page scroll area so the clock and both stop controls remain reachable. */
export function TimecodeTransport({ state, connected, canStart, canStop, starting, stopping, stoppingAutomation, onStart, onStop, onStopAutomation }: Props) {
  const styles = useStyles();
  const status = !connected ? "Last known" : state?.signal?.status === "timecode-lost" || state?.signal?.status === "timecode-stalled"
    ? state.signal.status.replaceAll("-", " ") : state?.running ? "Running" : "Stopped";
  return <View style={styles.bar} testID="timecode-transport">
    <View style={styles.clockRow}>
      <Text accessibilityLabel={`Timecode ${state?.display ?? "unavailable"}`} style={styles.clock} maxFontSizeMultiplier={1.4}>{state?.display ?? "--:--:--:--"}</Text>
      <Text style={styles.status}>{status}</Text>
    </View>
    <Text style={styles.detail}>{!connected ? "Last known · " : ""}{!state ? "Automation state unavailable" : !state.triggersEnabled ? "Automation stopped" : state.automaticCuesEnabled === false ? "Automatic cues paused" : "Automation enabled"}</Text>
    <View style={styles.buttons}>
      <AppButton style={styles.button} label="Start freerun" loading={starting} disabled={!canStart} onPress={onStart} />
      <AppButton style={styles.button} label="Stop" variant="secondary" loading={stopping} disabled={!canStop} onPress={onStop} />
      <AppButton style={styles.automation} label="Stop automation" variant="danger" loading={stoppingAutomation} disabled={!canStop || stoppingAutomation} onPress={onStopAutomation} />
    </View>
  </View>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  bar: { gap: 8, padding: 12, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised },
  clockRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6 },
  clock: { fontFamily, color: colors.text, fontSize: 23, lineHeight: 29, fontWeight: "900", fontVariant: ["tabular-nums"] },
  status: { fontFamily, color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: "700" },
  detail: { fontFamily, color: colors.text, fontSize: 12, lineHeight: 16 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flexGrow: 1, flexBasis: 110, minHeight: 44, paddingHorizontal: 8 },
  automation: { flexGrow: 1, flexBasis: 180, minHeight: 44, paddingHorizontal: 8 },
}));
