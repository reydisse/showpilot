// Exercises the compiled sidecar's real stdin parser and WebSocket output.
// Rust decoder tests cover MIDI bytes; this probe starts at native JSON output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";

const targets = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "linux-x64": "x86_64-unknown-linux-gnu", "win32-x64": "x86_64-pc-windows-msvc.exe" };
const target = targets[`${process.platform}-${process.arch}`];
const executable = process.argv[2] ?? (target && resolve(import.meta.dirname, `../../bridge-desktop/src-tauri/binaries/showpilot-bridge-${target}`));
assert.ok(executable, "Pass the compiled sidecar path for this platform.");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const messages = [];
let child;
let diagnostics = "";
const waitFor = async predicate => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(child?.exitCode === null, `Sidecar exited: ${diagnostics}`);
    assert.ok(Date.now() < deadline, `Sidecar response timed out: ${diagnostics}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
try {
  server.on("connection", socket => {
    socket.on("message", bytes => { messages.push(JSON.parse(String(bytes))); });
    socket.send(JSON.stringify({ type: "bridge-role", role: "active", orgId: "midi-fixture", installationId: "midi-fixture", activeInstallation: { installationId: "midi-fixture", label: "MIDI fixture" }, approvedTargets: [], selectionId: "fixture" }));
  });
  child = spawn(resolve(executable), ["--desktop", "--no-open"], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SHOWPILOT_BRIDGE_URL: `ws://127.0.0.1:${server.address().port}`, SHOWPILOT_PARENT_PID: String(process.pid) },
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.on("data", data => { diagnostics = (diagnostics + String(data)).slice(-2000); });
  await waitFor(() => messages.some(message => message.type === "bridge-role-applied"));
  const feed = { type: "timecode-feed", timecode: { hours: 0, minutes: 0, seconds: 0, frames: 7 }, format: { frameRate: 30, dropFrame: "ndf" }, totalFrames: 7 };
  const expected = [{ type: "timecode-transport", state: "stopped" }, { type: "timecode-transport", state: "waiting" }, feed];
  // Invalid input must not escape the supervisor boundary or kill the sidecar.
  child.stdin.write('not json\n' + JSON.stringify({ type: "timecode-transport", state: "running" }) + '\n');
  child.stdin.write(JSON.stringify({ ...feed, timecode: { ...feed.timecode, frames: 99 } }) + '\n');
  for (const message of expected) child.stdin.write(JSON.stringify(message) + '\n');
  const received = () => messages.filter(message => message.type.startsWith("timecode-"));
  await waitFor(() => received().length === expected.length);
  assert.deepEqual(received(), expected);
  console.log(JSON.stringify({ compiledStdinBoundary: "passed", malformedInputRejected: "passed", transportAndFrameOrder: "passed", realWebSocketOutput: "passed" }, null, 2));
} finally {
  if (child?.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
}
