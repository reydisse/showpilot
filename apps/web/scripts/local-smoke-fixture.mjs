// Disposable local Wrangler/D1/Chromium fixture shared by browser rehearsals.
// Uses the built application and real authentication. No remote data or existing browser sessions.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac, randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { hashPassword } from "better-auth/crypto";

const run = promisify(execFile);
const web = resolve(import.meta.dirname, "..");
export async function withLocalSmokeFixture(check, { secondShow = false, secondOperator = false, secondOperatorMember = false, dateOnlyIncident = false, unverifiedOperator = false, paidPlan = false, damagedGraphicScenes = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "showpilot-display-smoke-"));
  const session = `display-smoke-${process.pid}`;
  const secret = randomUUID();
  const authSecret = randomUUID();
  const companionSecret = randomUUID();
  const encryptionSecret = JSON.stringify({ active: "fixture", keys: { fixture: randomBytes(32).toString("base64") } });
  const orgId = "display-smoke";
  const date = new Date().toLocaleDateString("en-CA");
  let worker;
  let workerLog = "";

  async function browser(...args) {
    // Playwright's repeated string evaluation can hit the production CSP after
    // the first poll. Evaluate each condition through the automation channel;
    // do not weaken the application's script policy to make a rehearsal pass.
    if (args[0] === "wait" && args[1] === "--fn" && args.length === 3) {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const value = await browser("eval", args[2]);
        if (value.result) return value;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Browser condition did not become true within 25 seconds.");
    }
    const { stdout } = await run("agent-browser", ["--session", session, "--json", ...args], { timeout: 45_000 });
    const result = JSON.parse(stdout);
    assert.equal(result.success, true, result.error);
    return result.data;
  }
  async function wrangler(...args) {
    return run("pnpm", ["exec", "wrangler", ...args], { cwd: web, timeout: 60_000, maxBuffer: 2_000_000, env: args.includes("--json") ? { ...process.env, WRANGLER_LOG: "log" } : process.env });
  }
  function signFixtureToken(payload) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const message = `${header}.${body}`;
    return `${message}.${createHmac("sha256", secret).update(message).digest("base64url")}`;
  }
  function pass(surface, org = orgId, expired = false, lifetimeSeconds = 300) {
    const iat = Math.floor(Date.now() / 1000) - (expired ? 60 : 0);
    return signFixtureToken({ purpose: "showpilot-display-v1", orgId: org, surface, iat, exp: iat + (expired ? 1 : lifetimeSeconds), nonce: randomUUID() });
  }
  function crewChatPass(seconds = 300) {
    const iat = Math.floor(Date.now() / 1000);
    return `chat_${signFixtureToken({ scope: "crew-chat", orgId, orgSlug: orgId, iat, exp: iat + seconds })}`;
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
      // Wrangler registers dev Workers by name across processes. Keep a server
      // restart in one fixture from replacing another fixture's proxy target.
      name: `showpilot-smoke-${process.pid}`,
      main: join(web, "dist/server/index.js"), assets: { directory: join(web, "dist/client") },
      vars: { CREDENTIAL_ENCRYPTION_KEYS: encryptionSecret, KIOSK_SECRET: secret, COMPANION_SECRET: companionSecret, BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: origin },
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
    const sceneFixture = (id, name, templateId = "classic") => ({ id, name,
      items: [{ key: "__draft__", name: "Saved first", title: "Saved first", subtitle: "Speaker", style: JSON.stringify({templateId,controls:{accentColor:"#f59e0b",bgOpacity:85,primarySize:46,secondarySize:26,posX:5,posY:82,animSpeed:"normal"}}) }],
      createdAt:"2026-11-06T00:00:00.000Z", updatedAt:"2026-11-06T00:00:00.000Z" });
    const fixtureSceneValues = [
      ["healthy",JSON.stringify(sceneFixture("healthy","Healthy scene"))],
      ["bad-json","{"],
      ["bad-style",JSON.stringify({...sceneFixture("bad-style","Damaged layers"),items:[{...sceneFixture("bad-style","Damaged layers").items[0],style:"{}"}]})],
      ["unsupported",JSON.stringify(sceneFixture("unsupported","Future template","unavailable-renderer"))],
      ["mismatch",JSON.stringify(sceneFixture("healthy","Mismatched ID"))],
    ];
    const damagedScenesSeed = damagedGraphicScenes ? fixtureSceneValues.map(([id,value]) =>
      `INSERT INTO app_setting(id,orgId,key,value) VALUES ('fixture-scene-${id}','display-smoke','graphic-scene:${id}','${value.replaceAll("'","''")}');`).join("\n") : "";
    const seed = `
  INSERT INTO organization (id,name,slug,createdAt) VALUES ('display-smoke','Display fixture','display-smoke',CURRENT_TIMESTAMP), ('display-other','Other fixture','display-other',CURRENT_TIMESTAMP);
  ${damagedScenesSeed}
  ${dateOnlyIncident ? "INSERT INTO incident(id,orgId,category,severity,description,reportedBy,serviceDate) VALUES ('smoke-date-incident','display-smoke','audio','high','Date-only fixture incident','Mobile fixture','2000-01-01');" : ""}
  ${paidPlan ? "UPDATE organization SET plan = 'pro' WHERE id = 'display-smoke';" : ""}
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-operator','Fixture operator','operator@display-smoke.invalid',1,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-account','smoke-operator','credential','smoke-operator','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('smoke-member','display-smoke','smoke-operator','owner',CURRENT_TIMESTAMP);
  ${secondOperator ? `
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-second-operator','Second fixture operator','second@display-smoke.invalid',1,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-second-account','smoke-second-operator','credential','smoke-second-operator','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('smoke-second-member','display-smoke','smoke-second-operator','${secondOperatorMember ? "member" : "owner"}',CURRENT_TIMESTAMP);
  ` : ""}
  ${unverifiedOperator ? `
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-unverified','Unverified operator','unverified@display-smoke.invalid',0,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-unverified-account','smoke-unverified','credential','smoke-unverified','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  ` : ""}
  INSERT INTO rundown (id,orgId,serviceDate,name) VALUES ('smoke-show','display-smoke','${date}','Display test show');
  ${secondShow ? `INSERT INTO rundown (id,orgId,serviceDate,name) VALUES ('smoke-second-show','display-smoke','${date}','Evening test show');` : ""}
  INSERT INTO app_setting (id,orgId,key,value) VALUES ('smoke-message','display-smoke','rundown-message:smoke-show','Fixture private stage message'), ('smoke-active','display-smoke','active-graphics','["smoke-graphic"]'), ('smoke-show-setting','display-smoke','active-show-id','smoke-show');
  INSERT INTO graphic_template (id,orgId,name,title,subtitle,updatedAt) VALUES ('smoke-graphic','display-smoke','Fixture','Fixture overlay title','Fixture subtitle',CURRENT_TIMESTAMP);
  `;
    const sqlPath = join(directory, "fixture.sql");
    await writeFile(sqlPath, `${schema}\n${seed}`);
    await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state, "--file", sqlPath);
    const startServer = async () => {
      worker = process.env.SHOWPILOT_SMOKE_RUNTIME === "miniflare"
        ? spawn(process.execPath, [join(web, "scripts/local-smoke-runtime.mjs"), configPath, state, String(port)], { cwd: web, detached: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--config", configPath, "--persist-to", state, "--port", String(port), "--inspector-port", "0", "--ip", "127.0.0.1"], { cwd: web, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      worker.stdout.on("data", (chunk) => { workerLog += chunk; });
      worker.stderr.on("data", (chunk) => { workerLog += chunk; });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(worker.exitCode, null, "Local Worker exited before becoming ready");
        try { const response = await fetch(`${origin}/api/overlay/${orgId}`); ready = response.status === 401; await response.arrayBuffer(); } catch { /* Starting. */ }
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
    await login.arrayBuffer();
    const stage = await fetch(`${origin}/api/rundown/${orgId}/command?showId=smoke-show&serviceDate=${date}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin }, body: JSON.stringify({ action: "stage-message", payload: { message: "Fixture private stage message" } }) });
    assert.equal(stage.status, 200, "Fixture live stage message");
    assert.equal((await stage.json()).ok, true);

    const queryFixture = async (sql) => {
      assert.match(sql, /^SELECT\s/i, "Fixture inspection accepts only SELECT queries");
      const { stdout } = await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state, "--command", sql, "--json");
      return JSON.parse(stdout)[0].results;
    };
    const revokeFixtureOperator = () => wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state,
      "--command", "DELETE FROM member WHERE organizationId='display-smoke' AND userId='smoke-operator'");
    const repairGraphicSceneFixtures = async () => {
      assert.ok(damagedGraphicScenes, "Scene repair is available only for the damaged-scene fixture");
      const repair = ["bad-json","bad-style","unsupported"].map(id => {
        const name = id === "unsupported" ? "Future template" : id === "bad-style" ? "Damaged layers" : "Repaired scene";
        return `UPDATE app_setting SET value='${JSON.stringify(sceneFixture(id,name)).replaceAll("'","''")}' WHERE orgId='display-smoke' AND key='graphic-scene:${id}';`;
      }).join("\n");
      await wrangler("d1","execute","showpilot-db","--local","--config",configPath,"--persist-to",state,"--command",repair);
    };
    await check({ origin, orgId, date, browser, pass, crewChatPass, stopServer, startServer, serverState: () => ({ exitCode: worker?.exitCode ?? null, signalCode: worker?.signalCode ?? null }), queryFixture, revokeFixtureOperator, repairGraphicSceneFixtures, operatorCookie: cookie, operatorEmail: "operator@display-smoke.invalid", operatorPassword: password });
  } catch (error) {
    // Configuration contains only disposable fixture secrets; redact them anyway.
    console.error(workerLog.replaceAll(secret, "[fixture secret]").replaceAll(authSecret, "[fixture secret]").replaceAll(companionSecret, "[fixture secret]").replaceAll(encryptionSecret, "[fixture secret]"));
    throw error;
  } finally {
    await browser("close").catch(() => {});
    await stopServer();
    await rm(directory, { recursive: true, force: true });
  }

}
