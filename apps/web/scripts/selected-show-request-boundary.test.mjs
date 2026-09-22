import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const files = [
  "src/routes/$slug/dashboard/audio.tsx",
  "src/routes/$slug/production/checklist.tsx",
];

for (const file of files) {
  test(`${file} rejects stale selected-show responses`, () => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    if (!source.includes("RequestRef.current !== requestId")) {
      throw new Error(`${file} must reject responses from obsolete show requests`);
    }
    if (!source.includes("RequestRef.current === requestId) setLoading")) {
      throw new Error(`${file} must let only the current request clear loading state`);
    }
  });
}
