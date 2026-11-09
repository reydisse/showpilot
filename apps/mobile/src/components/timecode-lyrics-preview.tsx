import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { LyricsTextPreview } from "./lyrics-text-preview";
import { OperationsEmpty, OperationsError, OperationsPanel } from "./operations-ui";
import type { MobileTimecodeState } from "../lib/timecode-contract";
import type { useTimecodeLyricsControls } from "../hooks/use-timecode-lyrics-controls";
import { lyricsControlLabels } from "../lib/timecode-lyrics-recovery";
import { createThemedStyles, fontFamily } from "../theme/tokens";
export function TimecodeLyricsPreview({ lyrics, controls, showName, connected }: {
  lyrics: MobileTimecodeState["lyrics"]; controls: ReturnType<typeof useTimecodeLyricsControls>; showName: string;
  connected: boolean;
}) {
  const styles = useStyles(), { review, attempt } = controls;
  return <OperationsPanel title="Lyrics preview" detail={connected ? "Current lyrics on this show's displays." : "Last known lyrics. Reconnect before changing the output."}>
    {lyrics ? <>
      <Text style={styles.title}>{lyrics.songTitle} · {lyrics.sectionLabel}</Text>
      <LyricsTextPreview text={lyrics.lyrics} nextLabel={lyrics.nextLabel} />
    </> : <OperationsEmpty>No lyrics on output. Choose a song section in Songs or fire a Show Lyrics Section cue.</OperationsEmpty>}
    <View style={styles.row}>
      {(["previous", "next", "clear"] as const).map(operation => <AppButton key={operation} style={styles.button} label={lyricsControlLabels[operation]}
        variant={operation === "clear" ? "danger" : "secondary"} disabled={!controls.canReview || controls.locked} onPress={() => controls.prepare(operation)} />)}
    </View>
    {controls.error ? <OperationsError message={controls.error} /> : null}
    {review ? <View style={styles.review}>
      <Text accessibilityRole="header" style={styles.title}>{lyricsControlLabels[review.command.operation]}?</Text>
      <Text style={styles.text}>Show: {showName}. Reviewing {review.songTitle} · {review.sectionLabel}.</Text>
      <Text style={styles.text}>{review.command.operation === "clear" ? "Clear lyrics from this show's connected displays. The clock and other outputs continue." : `Replace the displayed lyrics with the ${review.command.operation} saved song section.`}</Text>
      {controls.changed ? <><OperationsError message="Lyrics changed after review. Review the current section before confirming." /><AppButton label="Review current lyrics" variant="secondary" disabled={!controls.canReview} onPress={controls.reviewCurrent} /></> : null}
      {!controls.canReview ? <OperationsError message="Connect, claim control and show a song section before confirming." /> : null}
      <AppButton label="Keep current lyrics" variant="secondary" onPress={controls.cancel} />
      <AppButton label={`Confirm ${lyricsControlLabels[review.command.operation].toLowerCase()}`} disabled={!controls.canReview || controls.changed} onPress={controls.confirm} />
    </View> : null}
    {attempt ? <View style={styles.review}>
      <Text accessibilityRole="header" style={styles.title}>{attempt.label}</Text>
      <Text accessibilityRole="alert" style={styles.text}>{attempt.kind === "pending" ? "Waiting for the relay to confirm…" : attempt.kind === "failed" ? attempt.message
        : attempt.result.outcome === "applied" ? "Lyrics change confirmed. Later display changes are preserved." : attempt.result.message ?? "The lyrics change was not applied."}</Text>
      {attempt.kind === "failed" ? <AppButton label="Retry original lyrics change" disabled={!controls.canRecover} onPress={controls.retry} /> : null}
      {attempt.kind === "confirmed" && attempt.refresh === "pending" ? <Text style={styles.text}>Refreshing current lyrics…</Text> : null}
      {attempt.kind === "confirmed" && (attempt.refresh === "failed" || attempt.refresh === "idle") ? <><OperationsError message={attempt.message ?? "Refresh the current lyrics."} /><AppButton label="Retry lyrics refresh" disabled={!connected} onPress={controls.refresh} /></> : null}
      {attempt.kind === "confirmed" && attempt.refresh === "done" ? <AppButton label="Continue with current lyrics" variant="secondary" onPress={controls.finish} /> : null}
    </View> : null}
  </OperationsPanel>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { flexGrow: 1, flexBasis: 130 },
  review: { gap: 12, borderRadius: 14, padding: 12, backgroundColor: colors.amberSoft },
  title: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20, fontWeight: "800" },
  text: { color: colors.text, fontFamily, fontSize: 13, lineHeight: 19 },
}));
