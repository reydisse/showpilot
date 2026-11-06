import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const moduleUrl = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../local-show-ownership.ts",
  ),
).href;
const children: ChildProcess[] = [];
const directories: string[] = [];
const orphanPids: number[] = [];
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showpilot-local-owner-"));
  directories.push(dir);
  return dir;
}
function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
async function kill(child: ChildProcess) {
  const exited = waitForExit(child);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
  await exited;
}
function launch(script: string, ...args: string[]) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
      ...args,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (data) => {
    stderr += String(data);
  });
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error(`Ownership child did not reply: ${stderr}`)),
      5000,
    );
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("\n")) {
        clearTimeout(timeout);
        resolve(JSON.parse(stdout.split("\n")[0]));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timeout);
      if (!stdout.includes("\n"))
        reject(new Error(`Ownership child exited before reply: ${stderr}`));
    });
  });
  return { child, result };
}
const acquireScript = `
import { acquireLocalShowOwnership } from ${JSON.stringify(moduleUrl)};
try {
  await acquireLocalShowOwnership(process.argv[1]);
  console.log(JSON.stringify({ acquired: true, pid: process.pid }));
  setInterval(() => {}, 1000);
} catch (error) {
  console.log(JSON.stringify({ acquired: false, error: error.message }));
  process.exitCode = 1;
}`;
const owner = (dir: string) => launch(acquireScript, dir);
afterEach(async () => {
  for (const child of children.splice(0)) await kill(child);
  for (const pid of orphanPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      )
        throw error;
    }
  }
  for (const dir of directories.splice(0))
    await fs.promises.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 25,
    });
});

it("allows only one engine per directory, including concurrent first startup", async () => {
  // Both processes can reach SQLite's first-open initialization together.
  // Repeat with new files to exercise that race, not just an existing owner.
  for (let attempt = 0; attempt < 25; attempt++) {
    const dir = directory();
    const a = owner(dir), b = owner(dir);
    const results = await Promise.all([a.result, b.result]);
    expect(results.filter(result => result.acquired), JSON.stringify(results)).toHaveLength(1);
    expect(results.find(result => !result.acquired)?.error).toMatch(/Another local device engine still owns/);
    await Promise.all([kill(a.child), kill(b.child)]);
  }
  const other = owner(directory());
  expect(await other.result).toMatchObject({ acquired: true });
}, 15000);
it("recovers automatically after a forced engine crash without deleting the lock file", async () => {
  const dir = directory();
  const first = owner(dir);
  expect(await first.result).toMatchObject({ acquired: true });
  const file = path.join(dir, "owner.sqlite");
  const original = fs.statSync(file);
  await kill(first.child);
  const replacement = owner(dir);
  expect(await replacement.result).toMatchObject({ acquired: true });
  expect(fs.statSync(file).ino).toBe(original.ino);
});
it("uses the same owner through a directory alias", async () => {
  const dir = directory();
  const first = owner(dir);
  expect(await first.result).toMatchObject({ acquired: true });
  const alias = path.join(directory(), "alias");
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  expect(await owner(alias).result).toMatchObject({
    acquired: false,
    error: expect.stringMatching(/Another local device engine still owns/),
  });
});
it("fails closed on invalid storage and never truncates it", async () => {
  const dir = directory();
  const file = path.join(dir, "owner.sqlite");
  fs.writeFileSync(file, "invalid-sqlite-owner-record");
  expect(await owner(dir).result).toMatchObject({
    acquired: false,
    error: expect.stringMatching(/could not be secured/),
  });
  expect(fs.readFileSync(file, "utf8")).toBe("invalid-sqlite-owner-record");
});
it("rejects a relative directory", async () => {
  expect(await owner("relative-storage").result).toMatchObject({
    acquired: false,
    error: expect.stringMatching(/absolute storage directory/),
  });
});
it("keeps engine ownership after its parent is killed", async () => {
  const dir = directory();
  // The child deliberately has no parent watchdog. The kernel lock itself must
  // remain exclusive for as long as this orphan is alive, independent of timers.
  const parent = launch(
    `
    import { spawn } from 'node:child_process';
    const child=spawn(process.execPath, ['--experimental-strip-types','--input-type=module','-e',${JSON.stringify(acquireScript)},process.argv[1]], { detached:true, stdio:['ignore','pipe','ignore'] });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    setInterval(()=>{},1000);
  `,
    dir,
  );
  const acquired = await parent.result;
  expect(acquired.acquired).toBe(true);
  if (typeof acquired.pid !== "number") throw Error("Missing engine pid");
  const enginePid = acquired.pid;
  orphanPids.push(enginePid);
  await kill(parent.child);
  process.kill(enginePid, 0);
  expect(await owner(dir).result).toMatchObject({
    acquired: false,
    error: expect.stringMatching(/Another local device engine still owns/),
  });
  process.kill(enginePid, 0);
});

it("rejects a repeated acquisition in the same process without releasing its existing OS lock", async () => {
  const dir = directory();
  const repeated = launch(
    `
    import { acquireLocalShowOwnership } from ${JSON.stringify(moduleUrl)};
    await acquireLocalShowOwnership(process.argv[1]);
    let duplicateBlocked = false;
    try { await acquireLocalShowOwnership(process.argv[1]); } catch { duplicateBlocked = true; }
    console.log(JSON.stringify({ acquired: true, duplicateBlocked }));
    setInterval(() => {}, 1000);
  `,
    dir,
  );
  expect(await repeated.result).toEqual({
    acquired: true,
    duplicateBlocked: true,
  });
  expect(await owner(dir).result).toMatchObject({
    acquired: false,
    error: expect.stringMatching(/Another local device engine still owns/),
  });
});
