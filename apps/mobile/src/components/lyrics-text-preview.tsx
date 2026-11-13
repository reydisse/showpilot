import { useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { startTextFit, advanceTextFit, type TextFit } from "@showpilot/shared";
import { createThemedStyles, fontFamily } from "../theme/tokens";

/** Share the confidence monitor's measured fit, but expand at a readable floor
 * rather than hiding lyrics that cannot fit in a small operator preview. */
export function LyricsTextPreview({ text, nextLabel }: { text: string; nextLabel: string }) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const { fontScale } = useWindowDimensions();
  const height = Math.max(200, Math.min(360, width * 9 / 16));
  const identity = JSON.stringify([text, width, fontScale]);
  const current = useRef(identity); current.current = identity;
  const initial = useMemo(() => startTextFit(Math.min(width * 0.09, height * 0.29), 12), [width, height]);
  const [measurement, setMeasurement] = useState<{ identity: string; fit: TextFit } | null>(null);
  const fit = measurement?.identity === identity ? measurement.fit : initial;
  return <View style={styles.preview} testID="lyrics-preview">
    <View style={{ minHeight: height, justifyContent: "center" }} onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))}>
      <Text testID="lyrics-preview-text" style={[styles.lyrics, { fontSize: fit.size, lineHeight: fit.size * 1.2 }]} onLayout={event => {
        if (!width || fit.done || current.current !== identity) return;
        const fits = event.nativeEvent.layout.height <= height + 1;
        setMeasurement(previous => {
          if (current.current !== identity || previous?.identity === identity && previous.fit !== fit) return previous;
          return { identity, fit: advanceTextFit(fit, fits) };
        });
      }}>{text}</Text>
    </View>
    <Text style={styles.next}>{nextLabel ? `NEXT · ${nextLabel}` : "END OF SONG"}</Text>
  </View>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  preview: { gap: 16, borderRadius: 18, backgroundColor: colors.black, padding: 16 },
  lyrics: { color: colors.white, fontFamily, fontWeight: "800", textAlign: "center" },
  next: { color: colors.white, fontFamily, fontSize: 12, lineHeight: 18, fontWeight: "800" },
}));
