import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { useTimecodeCueEdit } from "../hooks/use-timecode-cue-edit";
import { AppButton } from "./app-button";
import { OperationsError, OperationsPanel } from "./operations-ui";
import { TimecodeCueFields } from "./timecode-cue-fields";
import { createThemedStyles, fontFamily } from "../theme/tokens";
export function TimecodeCueEditor({ scope, editor, canSave, connected }: {
  scope: { orgId: string; userId: string; showId: string }; editor: ReturnType<typeof useTimecodeCueEdit>; canSave: boolean; connected: boolean;
}) {
  const styles = useStyles();
  const [valid, setValid] = useState(false);
  const draft = editor.draft, attempt = editor.attempt;
  if (!draft) return null;
  return <OperationsPanel title="Edit cue" detail="Your draft stays with this show when you navigate away.">
      <View style={styles.group}>
        {editor.error ? <OperationsError message={editor.error} /> : null}
        {editor.changed && !attempt ? <><OperationsError message="The cue or frame rate changed. Your draft is kept; it cannot overwrite the current cue." />
          <AppButton label="Replace draft with current cue" variant="secondary" disabled={!canSave} onPress={editor.reload} /></> : null}
        <TimecodeCueFields scope={scope} draft={draft.definition} update={editor.update} disabled={Boolean(attempt)} editing changeDetails={draft.changeDetails} onValid={setValid} />
        <AppButton label={draft.changeDetails ? "Keep saved action details" : "Change action details"} variant="secondary" disabled={Boolean(attempt)} onPress={() => editor.changeDetails(!draft.changeDetails)} />
        {attempt ? <View style={styles.group}>
          <Text accessibilityRole="alert" style={styles.text}>{attempt.kind === "pending" ? "Saving cue edit… Your draft is kept." : attempt.kind === "failed" ? attempt.message
            : attempt.result.outcome === "applied" ? "Cue edit saved. Recovery preserves later changes and execution history." : attempt.result.message ?? "The cue edit was not applied."}</Text>
          {attempt.kind === "failed" ? <AppButton label="Retry original cue edit" disabled={!canSave} onPress={editor.retry} /> : null}
          {attempt.kind === "confirmed" && attempt.refresh === "pending" ? <Text style={styles.text}>Refreshing current cues…</Text> : null}
          {attempt.kind === "confirmed" && (attempt.refresh === "failed" || attempt.refresh === "idle") ? <><OperationsError message={attempt.message ?? "Refresh the current timeline."} /><AppButton label="Retry edited timeline refresh" disabled={!connected} onPress={editor.refresh} /></> : null}
          {attempt.kind === "confirmed" && attempt.refresh === "done" ? <AppButton label={attempt.result.outcome === "applied" ? "Done editing cue" : "Review retained cue edit"} onPress={editor.finish} /> : null}
        </View> : <AppButton label="Save cue changes" disabled={!canSave || !valid || editor.changed} onPress={editor.save} />}
      </View>
      {!attempt ? <AppButton label="Discard cue edit" variant="secondary" onPress={editor.cancel} /> : null}
  </OperationsPanel>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  group: { gap: 12 }, text: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 21 },
}));
