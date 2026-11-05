// Disposable local Wrangler/D1/Chromium fixture shared by browser rehearsals.
// Uses the built application and real authentication. No remote data or existing browser sessions.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hashPassword } from "better-auth/crypto";

const run = promisify(execFile);
const web = resolve(import.meta.dirname, "..");
export async function withLocalSmokeFixture(check) {
  const directory = await mkdtemp(join(tmpdir(), "showpilot-display-smoke-"));
  const session = `display-smoke-${process.pid}`;
  const secret = randomUUID();
  const orgId = "display-smoke";
  const date = new Date().toLocaleDateString("en-CA");
  let worker;
  let workerLog = "";

  async function browser(...args) {
    const { stdout } = await run("agent-browser", ["--session", session, "--json", ...args], { timeout: 45_000 });
    const result = JSON.parse(stdout);
    assert.equal(result.success, true, result.error);
    return result.data;
  }
  async function wrangler(...args) {
    return run("pnpm", ["exec", "wrangler", ...args], { cwd: web, timeout: 60_000, maxBuffer: 2_000_000 });
  }
  function pass(surface, org = orgId, expired = false) {
    const iat = Math.floor(Date.now() / 1000) - (expired ? 60 : 0);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ purpose: "showpilot-display-v1", orgId: org, surface, iat, exp: iat + (expired ? 1 : 300), nonce: randomUUID() })).toString("base64url");
    const message = `${header}.${body}`;
    return `${message}.${createHmac("sha256", secret).update(message).digest("base64url")}`;
  }
  async function availablePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  async function stopServer() {
    if (!worker?.pid || worker.exitCode !== null || worker.signalCode !== null) return;
    const stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Local Worker did not stop")), 5000);
      worker.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    process.kill(-worker.pid, "SIGTERM");
    await stopped;
  }

  try {
    const built = JSON.parse(await readFile(join(web, "dist/server/wrangler.json"), "utf8"));
    const port = await availablePort();
    const origin = `http://127.0.0.1:${port}`;
    const config = Object.fromEntries(["name", "compatibility_date", "compatibility_flags", "durable_objects", "migrations", "d1_databases", "r2_buckets", "rules", "no_bundle"].map((key) => [key, built[key]]));
    Object.assign(config, {
      main: join(web, "dist/server/index.js"), assets: { directory: join(web, "dist/client") },
      vars: { KIOSK_SECRET: secret, BETTER_AUTH_SECRET: randomUUID(), BETTER_AUTH_URL: origin },
    });
    const configPath = join(directory, "wrangler.json");
    const state = join(directory, "state");
    await writeFile(configPath, JSON.stringify(config));
    const migrations = (await readdir(join(web, "prisma/migrations"))).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    assert.ok(migrations.length > 0);
    migrations.forEach((name, index) => assert.equal(Number(name.slice(0, 4)), index + 1));
    const schema = (await Promise.all(migrations.map((name) => readFile(join(web, "prisma/migrations", name), "utf8")))).join("\n\n");
    const password = randomUUID();
    const passwordHash = await hashPassword(password);
    const seed = `
  INSERT INTO organization (id,name,slug,createdAt) VALUES ('display-smoke','Display fixture','display-smoke',CURRENT_TIMESTAMP), ('display-other','Other fixture','display-other',CURRENT_TIMESTAMP);
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-operator','Fixture operator','operator@display-smoke.invalid',1,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-account','smoke-operator','credential','smoke-operator','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('smoke-member','display-smoke','smoke-operator','owner',CURRENT_TIMESTAMP);
  INSERT INTO rundown (id,orgId,serviceDate,name) VALUES ('smoke-show','display-smoke','${date}','Display test show');
  INSERT INTO app_setting (id,orgId,key,value) VALUES ('smoke-message','display-smoke','rundown-message:smoke-show','Fixture private stage message'), ('smoke-active','display-smoke','active-graphics','["smoke-graphic"]'), ('smoke-show-setting','display-smoke','active-show-id','smoke-show');
  INSERT INTO graphic_template (id,orgId,name,title,subtitle,updatedAt) VALUES ('smoke-graphic','display-smoke','Fixture','Fixture overlay title','Fixture subtitle',CURRENT_TIMESTAMP);
  `;
    const sqlPath = join(directory, "fixture.sql");
    await writeFile(sqlPath, `${schema}\n${seed}`);
    await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state, "--file", sqlPath);
    const startServer = async () => {
      worker = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--config", configPath, "--persist-to", state, "--port", String(port), "--ip", "127.0.0.1"], { cwd: web, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      worker.stdout.on("data", (chunk) => { workerLog += chunk; });
      worker.stderr.on("data", (chunk) => { workerLog += chunk; });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(worker.exitCode, null, "Local Worker exited before becoming ready");
        try { ready = (await fetch(`${origin}/api/overlay/${orgId}`)).status === 401; } catch { /* Starting. */ }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(ready, "Local Worker did not become ready");
    };
    await startServer();
    // Seed live relay state through the real authenticated operator API. D1 alone
    // is not the active relay, and a display must never initialize an operator room.
    const login = await fetch(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email: "operator@display-smoke.invalid", password }) });
    assert.equal(login.status, 200, "Fixture operator login");
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    assert.ok(cookie);
    const stage = await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin }, body: JSON.stringify({ action: "stage-message", payload: { message: "Fixture private stage message" } }) });
    assert.equal(stage.status, 200, "Fixture live stage message");
    assert.equal((await stage.json()).ok, true);

    await check({ origin, orgId, date, browser, pass, stopServer, startServer, operatorCookie: cookie, operatorEmail: "operator@display-smoke.invalid", operatorPassword: password });
  } catch (error) {
    // Configuration contains only disposable fixture secrets; redact them anyway.
    console.error(workerLog.replaceAll(secret, "[fixture secret]"));
    throw error;
  } finally {
    await browser("close").catch(() => {});
    await stopServer();
    await rm(directory, { recursive: true, force: true });
  }

}
