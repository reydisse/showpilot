import { StyleSheet, Text, View } from "react-native";
import {
  AUTOMATION_ACTIONS, cueCountdown, cueTimingStatus, deviceCueSummary, isDeviceCue,
  nextAutomationEvent, orderedAutomationEvents, scheduledDispatchFrame, webhookCueSummary,
  type AutomationDeviceNames, type TimecodeCueOperation,
} from "@showpilot/shared";
import { AppButton } from "./app-button";
import { OperationsEmpty, OperationsError, OperationsPanel } from "./operations-ui";
import { useCueChoices } from "../hooks/use-cue-choices";
import { getMobileDevices } from "../lib/mobile-api";
import { timecodeEventStatus, type MobileTimecodeEvent, type MobileTimecodeState } from "../lib/timecode-contract";
import { createThemedStyles, fontFamily } from "../theme/tokens";

type Props = {
  orgId: string; userId: string; events: MobileTimecodeEvent[]; state: MobileTimecodeState;
  connected: boolean; canEdit: boolean; onEdit: (id: string) => void;
  onControl: (operation: TimecodeCueOperation, id?: string) => void;
};
export function TimecodeTimeline({ orgId, userId, events, state, connected, canEdit, onEdit, onControl }: Props) {
  const styles = useStyles();
  const hasDevice = events.some(isDeviceCue);
  const devices = useCueChoices([userId, orgId, "timeline-device-names"], async signal => {
    const result = await getMobileDevices(orgId, signal);
    return result.devices.map(device => ({ id: device.id, label: device.name, enabled: device.enabled }));
  }, hasDevice);
  const names: AutomationDeviceNames = devices.isFetching ? { status: "loading" }
    : devices.error ? { status: "error", message: devices.error.message }
    : { status: "ready", value: devices.data ?? [] };
  const ordered = orderedAutomationEvents(events);
  const next = nextAutomationEvent(events, state.totalFrames);
  const attention = ordered.filter(event => event.executionStatus === "failed" || cueTimingStatus(event, state.totalFrames) === "missed");
  const canFire = canEdit && state.triggersEnabled;
  return <OperationsPanel title="Automation timeline" detail={`${events.length} cue${events.length === 1 ? "" : "s"} · ${connected ? "Live relay state" : "Last known state"}`}>
    <View style={styles.notice} testID="next-cue">
      <Text style={styles.text}>{next ? `${connected ? "Next" : "Last known next"}: ${next.label} · ${scheduledDispatchFrame(next) <= state.totalFrames ? "Due now" : `in ${cueCountdown(scheduledDispatchFrame(next) - state.totalFrames, state.format)}`}` : "No upcoming cue"}{!state.running ? " · Clock held" : ""}</Text>
      {!state.triggersEnabled ? <Text style={styles.text}>Automation stopped. Cues will not fire.</Text>
        : state.automaticCuesEnabled === false ? <Text style={styles.text}>Automatic cues paused. Manual firing remains available.</Text> : null}
      {next ? <AppButton label="Fire next" disabled={!canFire} onPress={() => onControl("fire", next.id)} /> : null}
    </View>
    {hasDevice ? <View style={styles.group}>
      {devices.error ? <OperationsError message={`Device names unavailable. ${devices.error.message}`} /> : null}
      <AppButton label={devices.isFetching ? "Loading device names…" : devices.error ? "Retry device names" : "Refresh device names"} variant="secondary" disabled={devices.isFetching} onPress={() => void devices.refetch()} />
    </View> : null}
    {attention.length ? <View style={styles.attention} testID="cue-attention">
      <Text accessibilityRole="header" style={styles.status}>Missed / failed cues ({attention.length})</Text>
      {attention.map(event => <View key={event.id} style={styles.group}>
        <Text style={styles.text}>{event.label} · {event.executionStatus === "failed" ? "FAILED" : "MISSED"}{!event.enabled ? " · Disabled" : ""}{event.skipped ? " · Skipped" : ""}</Text>
        <AppButton label={event.executionStatus === "failed" ? "Retry" : "Fire now"} accessibilityLabel={`${event.executionStatus === "failed" ? "Retry" : "Fire"} ${event.label} from attention list`} variant="secondary"
          disabled={!canFire || !event.enabled || event.skipped} onPress={() => onControl(event.executionStatus === "failed" ? "retry" : "fire", event.id)} />
      </View>)}
    </View> : null}
    {ordered.map(event => {
      const timing = cueTimingStatus(event, state.totalFrames);
      const status = event.executionStatus === "failed" ? "FAILED" : timing === "missed" ? "MISSED" : timing === "overdue" ? "OVERDUE" : event.id === next?.id ? "NEXT" : timecodeEventStatus(event);
      const device = deviceCueSummary(event, names);
      const webhook = webhookCueSummary(event);
      const time = event.triggerTimecode;
      const label = `${[time.hours, time.minutes, time.seconds].map(value => String(value).padStart(2, "0")).join(":")}${state.format.dropFrame === "df" ? ";" : ":"}${String(time.frames).padStart(2, "0")}`;
      return <View key={event.id} testID={`timeline-cue-${event.id}`} style={[styles.cue, event.id === next?.id && styles.next]}>
        <Text accessibilityRole="header" style={styles.title}>{event.label}</Text>
        <Text style={styles.text}>{label} · {AUTOMATION_ACTIONS.find(option => option.value === event.action)?.label ?? event.action}</Text>
        <Text style={styles.status}>{status}{!event.enabled && (event.executionStatus === "failed" || event.executionStatus === "dispatching") ? " · Disabled" : ""}{event.skipped && event.executionStatus === "failed" ? " · Skipped" : ""}</Text>
        <Text style={styles.text}>Tolerance: {event.toleranceFrames ?? 5} frames (startup / resync)</Text>
        {(event.leadMs ?? 0) + (event.deviceLatencyMs ?? 0) > 0 ? <Text style={styles.text}>Send early: cue lead {event.leadMs ?? 0} ms + device {event.deviceLatencyMs ?? 0} ms</Text> : null}
        {device ? <><Text style={styles.text}>Device: {device.target}</Text><Text style={styles.text}>{device.details}</Text></> : null}
        {webhook ? <Text style={styles.text}>{webhook}</Text> : null}
        {event.executionError ? <OperationsError message={event.executionError} /> : null}
        <View style={styles.buttons}>
          <AppButton style={styles.button} label="Edit" accessibilityLabel={`Edit cue ${event.label}`} variant="secondary" disabled={!canEdit || event.executionStatus === "dispatching"} onPress={() => onEdit(event.id)} />
          <AppButton style={styles.button} label={event.enabled ? "Disable" : "Enable"} accessibilityLabel={`${event.enabled ? "Disable" : "Enable"} cue ${event.label}`} variant="secondary" disabled={!canEdit} onPress={() => onControl(event.enabled ? "disable" : "enable", event.id)} />
          {event.enabled && !event.skipped && event.executionStatus !== "dispatching" ? <AppButton style={styles.button} label={event.executionStatus === "failed" ? "Retry" : event.fired ? "Fire again" : "Fire now"}
            accessibilityLabel={`${event.executionStatus === "failed" ? "Retry" : event.fired ? "Fire again" : "Fire now"} cue ${event.label}`} disabled={!canFire}
            onPress={() => onControl(event.executionStatus === "failed" ? "retry" : event.fired ? "refire" : "fire", event.id)} /> : null}
          {event.fired || event.skipped || event.executionStatus === "failed" ? <AppButton style={styles.button} label="Re-arm" accessibilityLabel={`Re-arm cue ${event.label}`} variant="secondary" disabled={!canEdit || event.executionStatus === "dispatching"} onPress={() => onControl("rearm", event.id)} /> : null}
          <AppButton style={styles.button} label="Remove" accessibilityLabel={`Remove cue ${event.label}`} variant="danger" disabled={!canEdit || event.executionStatus === "dispatching"} onPress={() => onControl("remove", event.id)} />
        </View>
      </View>;
    })}
    {!events.length ? <OperationsEmpty>No automation cues in this show.</OperationsEmpty> : <AppButton label="Re-arm all cues" variant="secondary" disabled={!canEdit || state.running || events.some(event => event.executionStatus === "dispatching")} onPress={() => onControl("reset")} />}
  </OperationsPanel>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  group: { gap: 8 },
  notice: { gap: 10, backgroundColor: colors.amberSoft, borderRadius: 12, padding: 12 },
  attention: { gap: 12, backgroundColor: colors.redSoft, borderRadius: 12, padding: 12 },
  cue: { gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12 },
  next: { borderColor: colors.amber, backgroundColor: colors.amberSoft },
  title: { fontFamily, color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "800" },
  text: { fontFamily, color: colors.text, fontSize: 13, lineHeight: 19 },
  status: { fontFamily, color: colors.text, fontSize: 13, lineHeight: 19, fontWeight: "800" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flexGrow: 1, flexBasis: 100 },
}));
