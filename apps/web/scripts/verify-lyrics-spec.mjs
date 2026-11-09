import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requirements = [
  ["prisma/schema.prisma", ["model Song {", "model SongSection {", "model SongCueMap {", "model SongCue {"]],
  ["src/types/timecode.ts", ["lyrics-goto", "lyrics-clear", "pp-trigger-slide", "pp-trigger-next", "pp-trigger-clear"]],
  // Backward jumps must not re-arm already acknowledged actions. Behavioral
  // coverage lives in timecode-execution.worker.test.ts, not a reset marker.
  ["src/durable-objects/TimecodeRelay.ts", ["broadcastLyrics", "BRIDGE_RELAY"]],
  ["src/routes/$slug/songs.tsx", ["Import from ProPresenter", "Create manually"]],
  ["src/routes/$slug/songs.$songId.tsx", ["Tap-to-mark", "Native display", "ProPresenter", "Show now"]],
  ["src/routes/timer/$orgSlug.tsx", ["LyricsKiosk", "lyrics-update", "{lyrics.lyrics}", "observer.observe(area)"]],
  ["../bridge/src/protocols/propresenter.ts", ["queryPresentations", "/v1/libraries", "trigger-slide"]],
  // Changed-frame dedup replaces the old 100ms throttle, which could discard
  // the final locate timestamp. Decoder/transport behavior has Rust tests.
  ["../bridge-desktop/src-tauri/src/lib.rs", ["MtcTransportDecoder", "list_midi_inputs", "start_mtc_input", "timecode-transport"]],
  ["../bridge-desktop/src-tauri/src/mtc.rs", ["MtcQuarterFrameDecoder", "last_frame", "Transport::Stopped"]],
];

const missing = [];
for (const [file, markers] of requirements) {
  const content = await readFile(resolve(root, file), "utf8");
  for (const marker of markers) if (!content.includes(marker)) missing.push(`${file}: ${marker}`);
  if (file === "src/routes/timer/$orgSlug.tsx" && /\.slice\(0,\s*4\)/.test(content)) {
    missing.push(`${file}: lyrics must fit the display without discarding lines`);
  }
}
if (missing.length) {
  console.error(`Lyrics spec verification failed:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Lyrics spec structure verified (${requirements.length} implementation boundaries).`);
}
