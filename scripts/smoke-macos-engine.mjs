// Exercise the actual packaged engine against a loopback-only ShowPilot peer.
// Usage: node scripts/smoke-macos-engine.mjs <path-to-packaged-showpilot-bridge>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../apps/bridge/package.json", import.meta.url));
const { WebSocketServer } = require("ws");
assert(process.argv[2], "Provide the packaged engine executable path");
const cwd = await mkdtemp(join(tmpdir(), "showpilot-engine-smoke-"));
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const key = "local-smoke-test-only";
const child = spawn(resolve(process.argv[2]), ["--desktop", "--no-open"], {
  cwd,
  env: {
    PATH: process.env.PATH,
    SHOWPILOT_BRIDGE_URL: `ws://127.0.0.1:${server.address().port}/bridge`,
    SHOWPILOT_BRIDGE_KEY: key,
    SHOWPILOT_PARENT_PID: String(process.pid),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const closed = new Promise((done) => child.once("close", done));
let logs = "";
child.stdout.on("data", (data) => { logs += data; });
child.stderr.on("data", (data) => { logs += data; });
try {
  await new Promise((resolveTest, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Engine timed out: ${logs}`)), 20000);
    const fail = (error) => { clearTimeout(timeout); reject(error); };
    child.once("error", fail);
    child.once("exit", (code, signal) => fail(new Error(`Engine exited ${code}/${signal}: ${logs}`)));
    server.once("connection", (socket, request) => {
      try {
        assert.equal(request.headers["x-showpilot-api-key"], key);
        assert.equal(new URL(request.url, "http://localhost").searchParams.get("role"), "bridge");
      } catch (error) { fail(error); return; }
      let status = false;
      let pongs = 0;
      const batch = () => { for (let i = 0; i < 100; i++) socket.send('{"type":"ping"}'); };
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(String(data));
          if (message.type === "bridge-status") {
            assert.equal(typeof message.version, "string");
            assert.equal(message.devices, 0);
            if (!status) { status = true; batch(); }
          }
          if (message.type === "pong") {
            pongs++;
            if (pongs === 10000) {
              clearTimeout(timeout);
              resolveTest();
            } else if (pongs % 100 === 0) batch();
          }
        } catch (error) { fail(error); }
      });
    });
  });
  console.log("Packaged engine passed: authenticated connection, status, and 10,000 ping/pong messages.");
} finally {
  child.kill("SIGTERM");
  await closed;
  for (const client of server.clients) client.terminate();
  await new Promise((done) => server.close(done));
  await rm(cwd, { recursive: true, force: true });
}
