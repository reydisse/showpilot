import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requirements = [
  ["prisma/schema.prisma", ["model Song {", "model SongSection {", "model SongCueMap {", "model SongCue {"]],
  ["src/types/timecode.ts", ["lyrics-goto", "lyrics-clear", "pp-trigger-slide", "pp-trigger-next", "pp-trigger-clear"]],
  ["src/durable-objects/TimecodeRelay.ts", ["broadcastLyrics", "totalFrames < previousFrame", "BRIDGE_RELAY"]],
  ["src/routes/$slug/songs.tsx", ["Import from ProPresenter", "Create manually"]],
  ["src/routes/$slug/songs.$songId.tsx", ["Tap-to-mark", "Native display", "ProPresenter", "Show now"]],
  ["src/routes/timer/$orgSlug.tsx", ["LyricsKiosk", "lyrics-update", "slice(0, 4)"]],
  ["../bridge/src/protocols/propresenter.ts", ["queryPresentations", "/v1/libraries", "trigger-slide"]],
  ["../bridge-desktop/src-tauri/src/lib.rs", ["MtcQuarterFrameDecoder", "list_midi_inputs", "start_mtc_input", "Duration::from_millis(100)"]],
];

const missing = [];
for (const [file, markers] of requirements) {
  const content = await readFile(resolve(root, file), "utf8");
  for (const marker of markers) if (!content.includes(marker)) missing.push(`${file}: ${marker}`);
}
if (missing.length) {
  console.error(`Lyrics spec verification failed:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Lyrics spec structure verified (${requirements.length} implementation boundaries).`);
}
