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
import { createEmailVerificationToken } from "better-auth/api";

const run = promisify(execFile);
const web = resolve(import.meta.dirname, "..");
export async function withLocalSmokeFixture(check, { secondShow = false, reportRecovery = false, personalAssignments = false, calendarNavigation = false, notificationInbox = false, desktopNotificationRecovery = false, notificationTimezoneRecovery = false, accountProfileRecovery = false, secondOperator = false, secondOperatorMember = false, dateOnlyIncident = false, publicCheckInMembers = false, crewStatusMembers = false, navigationDiscovery = false, hiddenNavigation = false, unverifiedOperator = false, passwordReset = false, captureEmail = false, organizationCreationFailures = false, setupTeam = false, setupSeed = false, setupChoices = false, paidPlan = false, settingsBilling = false, damagedGraphicScenes = false, chatNotificationFailure = false, invitationResponses = false, teamRecovery = false, streamOutputs = false, timestampVersions = false } = {}) {
  if (streamOutputs) {
    assert.equal(process.env.SHOWPILOT_SMOKE_RUNTIME, "miniflare", "Stream status requires the isolated outbound handler");
    assert.equal(captureEmail, false, "Use separate fixtures for email and Stream status");
  }
  if (captureEmail) assert.equal(process.env.SHOWPILOT_SMOKE_RUNTIME, "miniflare", "Email capture requires the isolated outbound handler");
  const directory = await mkdtemp(join(tmpdir(), "showpilot-display-smoke-"));
  const session = `display-smoke-${process.pid}`;
  const secret = randomUUID();
  const authSecret = randomUUID();
  const companionSecret = randomUUID();
  const encryptionSecret = JSON.stringify({ active: "fixture", keys: { fixture: randomBytes(32).toString("base64") } });
  const orgId = "display-smoke";
  const resetTokens = Object.fromEntries(["valid", "expired", "lost"].map(name => [name, randomBytes(12).toString("hex")]));
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
  function planningChatPass(targetUserIds = ["smoke-operator"], seconds = 300, organizationId = orgId) {
    const iat = Math.floor(Date.now() / 1000);
    return `planning_chat_${signFixtureToken({ scope: "planning-chat", roomId: "planning", orgId: organizationId, orgSlug: organizationId, targetUserIds, iat, exp: iat + seconds })}`;
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
    if (captureEmail) {
      config.vars.RESEND_API_KEY = "local-email-capture-only";
      await writeFile(join(directory, "email-mode"), "success");
      await writeFile(join(directory, "emails.jsonl"), "");
    }
    if (streamOutputs) {
      config.vars.CLOUDFLARE_ACCOUNT_ID = "fixture-account";
      config.vars.CLOUDFLARE_STREAM_API_TOKEN = "local-stream-status-only";
      await writeFile(join(directory, "stream-output-mode"), "success");
      await writeFile(join(directory, "stream-output-fixture-kind"), streamOutputs === "inputs" ? "inputs" : streamOutputs === "commands" ? "commands" : "status");
      await writeFile(join(directory, "stream-output-snapshot.json"), "[]");
      await writeFile(join(directory, "stream-output-requests.jsonl"), "");
    }
    const configPath = join(directory, "wrangler.json");
    const state = join(directory, "state");
    await writeFile(configPath, JSON.stringify(config));
    const migrations = (await readdir(join(web, "prisma/migrations"))).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    assert.ok(migrations.length > 0);
    migrations.forEach((name, index) => assert.equal(Number(name.slice(0, 4)), index + 1));
    const migrationSql = await Promise.all(migrations.map((name) => readFile(join(web, "prisma/migrations", name), "utf8")));
    const splitAt = notificationTimezoneRecovery ? migrations.indexOf("0076_notification_timezone_recovery.sql") : accountProfileRecovery ? migrations.indexOf("0077_account_profile_recovery.sql") : migrations.length;
    assert.ok(splitAt >= 0);
    const schema = migrationSql.slice(0, splitAt).join("\n\n");
    const timezoneUpgrade = notificationTimezoneRecovery ? `
      INSERT INTO app_setting(id,orgId,key,value) VALUES ('fixture-old-timezone','display-smoke','notification-timezone:smoke-operator','America/Vancouver');
      ${migrationSql.slice(splitAt).join("\n\n")}` : migrationSql.slice(splitAt).join("\n\n");
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
  ${organizationCreationFailures ? `CREATE TRIGGER fixture_reject_created_owner BEFORE INSERT ON member
    WHEN NEW.organizationId IN (SELECT id FROM organization WHERE slug = 'atomic-failure-fixture')
    BEGIN SELECT RAISE(ABORT, 'fixture owner insertion failure'); END;` : ""}
  ${publicCheckInMembers ? "INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES ('fixture-attendance-one','display-smoke','TD3917','Previous fixture person','Director','','',0),('fixture-attendance-two','display-smoke','CAM42','Next fixture person','Camera','','',0),('fixture-attendance-other','display-other','TD3917','Other organization person','Director','','',0);" : ""}
  ${crewStatusMembers ? Array.from({length:6},(_,i)=>`INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES ('fixture-display-${i}','display-smoke','CREW${i}','Fixture crew member ${i}','Camera operator','','',${i%2});`).join("\n") : ""}
  ${navigationDiscovery ? `INSERT INTO app_setting(id,orgId,key,value) VALUES ('fixture-nav-type','display-smoke','workspace-type','church'),('fixture-nav-modules','display-smoke','workspace-modules','["show","rundown","team","schedule","board","chat","production","timecode","streaming","lower_thirds","dashboards"]');` : ""}
  ${dateOnlyIncident ? "INSERT INTO incident(id,orgId,category,severity,description,reportedBy,serviceDate) VALUES ('smoke-date-incident','display-smoke','audio','high','Date-only fixture incident','Mobile fixture','2000-01-01');" : ""}
  ${paidPlan ? "UPDATE organization SET plan = 'pro' WHERE id = 'display-smoke';" : ""}
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-operator','Fixture operator','operator@display-smoke.invalid',1,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-account','smoke-operator','credential','smoke-operator','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('smoke-member','display-smoke','smoke-operator','owner',CURRENT_TIMESTAMP);
  ${settingsBilling ? [
    ["trial", "free", "2099-01-01T00:00:00.000Z", 0, 0, null],
    ["starter", "starter", null, 0, 0, "active"],
    ["pro", "pro", null, 0, 0, "active"],
    ["founding", "pro", null, 1, 0, "active"],
    ["unpaid", "pro", null, 0, 0, "unpaid"],
    ["beta", "free", null, 0, 1, null],
    ["expired", "free", "2000-01-01T00:00:00.000Z", 0, 0, null],
  ].map(([name, plan, trial, founding, beta, status]) => `
    INSERT INTO organization(id,name,slug,createdAt,plan,trialEndsAt,foundingMember,betaTester,subscriptionStatus)
      VALUES ('billing-${name}','Billing ${name}','billing-${name}',CURRENT_TIMESTAMP,'${plan}',${trial ? "'"+trial+"'" : "NULL"},${founding},${beta},${status ? "'"+status+"'" : "NULL"});
    INSERT INTO member(id,organizationId,userId,role,createdAt)
      VALUES ('billing-member-${name}','billing-${name}','smoke-operator','owner',CURRENT_TIMESTAMP);
  `).join("\n") : ""}
  ${secondOperator ? `
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-second-operator','Second fixture operator','second@display-smoke.invalid',1,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-second-account','smoke-second-operator','credential','smoke-second-operator','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('smoke-second-member','display-smoke','smoke-second-operator','${hiddenNavigation ? "tm" : secondOperatorMember ? "member" : "owner"}',CURRENT_TIMESTAMP);
  ` : ""}
  ${hiddenNavigation ? `
  UPDATE organization SET cloud_enabled=0 WHERE id='display-smoke';
  INSERT INTO app_setting(id,orgId,key,value) VALUES ('fixture-hidden-pin','display-smoke','rundown-pin','1842');
  INSERT INTO device(id,orgId,name,category,adapterType,settings,enabled,updatedAt) VALUES ('navigation-device','display-smoke','Navigation fixture device','video','atem','{}',0,CURRENT_TIMESTAMP);
  INSERT INTO song(id,orgId,title,updatedAt) VALUES ('navigation-song','display-smoke','Navigation fixture song',CURRENT_TIMESTAMP);
  ` : ""}
  ${teamRecovery ? `
  INSERT INTO invitation(id,organizationId,email,role,status,expiresAt,inviterId,createdAt) VALUES ('team-fixture-invitation','display-smoke','invited@display-smoke.invalid','member','pending','${new Date(Date.now()+3600_000).toISOString()}','smoke-operator',CURRENT_TIMESTAMP);
  INSERT INTO content_report(id,orgId,reporterUserId,targetType,targetId,targetAuthorId,reason,details,status) VALUES ('team-fixture-report','display-smoke','smoke-operator','chat-message','fixture-message','smoke-second-operator','other','Please review this fixture message.','open');
  ` : ""}
  ${unverifiedOperator ? `
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('smoke-unverified','Unverified operator','unverified@display-smoke.invalid',0,CURRENT_TIMESTAMP);
  INSERT INTO account (id,accountId,providerId,userId,password,issuer,updatedAt) VALUES ('smoke-unverified-account','smoke-unverified','credential','smoke-unverified','${passwordHash}','local:credential',CURRENT_TIMESTAMP);
  ` : ""}
  ${invitationResponses ? `
  UPDATE organization SET plan='pro' WHERE id='display-other';
  INSERT INTO user (id,name,email,emailVerified,updatedAt) VALUES ('invitation-owner','Invitation owner','owner@invitation-smoke.invalid',1,CURRENT_TIMESTAMP);
  INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES ('invitation-owner-member','display-other','invitation-owner','owner',CURRENT_TIMESTAMP);
  ${["accept", "decline", "list", "expired", "canceled", "wrong", "unverified"].map(name => `INSERT INTO invitation(id,organizationId,email,role,status,expiresAt,inviterId,createdAt) VALUES
    ('invitation-${name}','display-other','${name === "wrong" ? "someone-else@invitation-smoke.invalid" : name === "unverified" ? "unverified@display-smoke.invalid" : "operator@display-smoke.invalid"}','member','${name === "canceled" ? "canceled" : "pending"}','${new Date(Date.now() + (name === "expired" ? -60_000 : 3600_000)).toISOString()}','invitation-owner',CURRENT_TIMESTAMP);`).join("\n")}
  ` : ""}
  ${passwordReset ? Object.entries(resetTokens).map(([name, token]) => `INSERT INTO verification (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES ('smoke-reset-${name}','reset-password:${token}','smoke-operator','${new Date(Date.now() + (name === "expired" ? -60_000 : 3600_000)).toISOString()}','${new Date().toISOString()}','${new Date().toISOString()}');`).join("\n") : ""}
  ${setupTeam || setupSeed || setupChoices ? `INSERT INTO app_setting(id,orgId,key,value) VALUES
    ('smoke-setup-start','display-smoke','onboarding-started','2026-11-06T00:00:00.000Z');
    ${!setupChoices ? `INSERT INTO app_setting(id,orgId,key,value) VALUES
    ('smoke-setup-workspace','display-smoke','workspace-type','church'),
    ('smoke-setup-role','display-smoke','onboarding-role:smoke-operator','{"archetype":"td","landing":"/show"}');` : ""}
    ${setupTeam ? `INSERT INTO app_setting(id,orgId,key,value) VALUES ('smoke-setup-seed','display-smoke','onboarding-template-seeded','{"template":"blank","serviceDate":"${date}"}');` : ""}` : ""}
  INSERT INTO rundown (id,orgId,serviceDate,name) VALUES ('smoke-show','display-smoke','${date}','Display test show');
  ${timestampVersions ? Object.entries({numeric: String(Date.parse("2090-01-01T00:00:00.000Z")), prisma: "'2090-01-01T00:00:00.000+00:00'", sqlite: "'2090-01-01 00:00:00'"}).flatMap(([format, value]) => ["details", "metadata", "timer"].map(kind => `INSERT INTO rundown (id,orgId,serviceDate,name,updatedAt) VALUES ('timestamp-${format}-${kind}','display-smoke','${date}','Timestamp fixture',${value});`)).join("\n") : ""}

  ${calendarNavigation ? `
    INSERT INTO rundown(id,orgId,serviceDate,name) VALUES
      ('calendar-february','display-smoke','2099-02-09','February calendar fixture');
  ` : ""}
  ${personalAssignments ? `
    INSERT INTO crew_member(id,orgId,memberId,name,role,email,photoUrl,isOnline) VALUES
      ('assignment-crew','display-smoke','ASSIGN1','Fixture operator','Camera','operator@display-smoke.invalid','',0),
      ('assignment-other-crew','display-smoke','ASSIGN2','Other crew','Camera','other@display-smoke.invalid','',0);
    INSERT INTO rundown(id,orgId,serviceDate,name,location) VALUES ('assignment-show','display-smoke','2099-01-01','Assignment keyboard fixture','LongLocationWithoutSpacesLongLocationWithoutSpaces');
    INSERT INTO service_assignment(id,orgId,showId,serviceDate,role,department,crewMemberId,status,notes) VALUES
      ('assignment-accept','display-smoke','assignment-show','2099-01-01','Camera operator','Production','assignment-crew','assigned','Arrive early'),
      ('assignment-decline','display-smoke','assignment-show','2099-01-01','Audio operator','Production','assignment-crew','assigned','Bring headset'),
      ('assignment-other','display-smoke','assignment-show','2099-01-01','Private other assignment','Production','assignment-other-crew','assigned','Private fixture notes');
  ` : ""}
  ${reportRecovery ? Array.from({length:11},(_,i)=>`INSERT INTO rundown(id,orgId,serviceDate,name) VALUES ('report-fixture-${i}','display-smoke','${date}','Report fixture ${i} ${i===0?'LongShowTitle'.repeat(20):''}');`).join('\n') : ''}
  ${secondShow ? `INSERT INTO rundown (id,orgId,serviceDate,name) VALUES ('smoke-second-show','display-smoke','${date}','Evening test show');` : ""}
  INSERT INTO app_setting (id,orgId,key,value) VALUES ('smoke-message','display-smoke','rundown-message:smoke-show','Fixture private stage message'), ('smoke-active','display-smoke','active-graphics','["smoke-graphic"]'), ('smoke-show-setting','display-smoke','active-show-id','smoke-show');
  INSERT INTO graphic_template (id,orgId,name,title,subtitle,updatedAt) VALUES ('smoke-graphic','display-smoke','Fixture','Fixture overlay title','Fixture subtitle',CURRENT_TIMESTAMP);
  `;
    if (teamRecovery) assert.ok(secondOperator && secondOperatorMember, "Team recovery needs a removable second fixture member");
    if (chatNotificationFailure) assert.ok(secondOperator, "Chat notification failure needs the second fixture member");
    const chatNotificationFault = chatNotificationFailure ? `CREATE TRIGGER fixture_chat_notification_failure BEFORE INSERT ON notification
      WHEN NEW.orgId='display-smoke' AND NEW.userId='smoke-second-operator' AND NEW.type='chat-planning-invite'
      BEGIN SELECT RAISE(ABORT, 'fixture notification failure'); END;` : "";
    const sqlPath = join(directory, "fixture.sql");
    const desktopNotificationSeed = desktopNotificationRecovery ? ["old", "a", "b", "c"].map((id, index) => `INSERT INTO notification(id,orgId,userId,type,severity,title,message,target,source,actionUrl,category,deviceAlertEnabled,dismissed,createdAt) VALUES('desktop-${id}','display-smoke','smoke-operator','fixture','info','Desktop ${id}','Fixture alert delivery','','fixture','schedule','system',1,0,'2026-11-08T00:00:0${index}.000Z');`).join("\n") : "";
    const inboxSeed = notificationInbox ? Array.from({ length: 35 }, (_, index) => `INSERT INTO notification(id,orgId,userId,type,severity,title,message,target,source,actionUrl,category,deviceAlertEnabled,dismissed,createdAt) VALUES('inbox-${String(index).padStart(2,'0')}','display-smoke','smoke-operator','fixture','info','Fixture alert ${index}','An operator message that remains readable on phones.','','fixture','schedule','system',0,0,'2026-11-08T00:00:00.000Z');`).join("\n") : "";
    const streamSeed = streamOutputs && streamOutputs !== "inputs" ? `
      INSERT INTO live_input(id,orgId,name,cfInputId) VALUES('smoke-input','display-smoke','Fixture ingest','fixture-input');
      ${(streamOutputs === "commands" ? ["alpha","beta"] : ["enabled","disabled","missing","pending"]).map(kind => `INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId) VALUES('smoke-${kind}','display-smoke','Fixture ${kind}','custom','rtmp://fixture.invalid/live','${streamOutputs === "commands" ? `fixture-${kind}-key` : "fixture-stream-key"}',1,'${streamOutputs === "commands" ? "" : kind === "pending" ? "pending:1:fixture" : `fixture-output-${kind}`}','${streamOutputs === "commands" ? "" : "smoke-input"}');`).join("\n")}
    ` : "";
    await writeFile(sqlPath, `${schema}\n${seed}\n${timezoneUpgrade}\n${chatNotificationFault}\n${streamSeed}\n${inboxSeed}\n${desktopNotificationSeed}`);
    await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state, "--file", sqlPath);
    const startServer = async () => {
      worker = process.env.SHOWPILOT_SMOKE_RUNTIME === "miniflare"
        ? spawn(process.execPath, [join(web, "scripts/local-smoke-runtime.mjs"), configPath, state, String(port), ...(streamOutputs ? ["", directory] : captureEmail ? [directory] : [])], { cwd: web, detached: true, stdio: ["ignore", "pipe", "pipe"] })
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
    const unverifiedOperatorLink = async () => {
      assert.ok(unverifiedOperator, "Verification links are available only for the unverified fixture account");
      const token = await createEmailVerificationToken(authSecret, "unverified@display-smoke.invalid");
      const url = new URL("/api/auth/verify-email", origin);
      url.searchParams.set("token", token); url.searchParams.set("callbackURL", "/verify-email");
      return url.toString();
    };
    const restoreChatNotifications = async () => {
      assert.ok(chatNotificationFailure, "Only the chat notification fixture can restore this fault");
      await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state,
        "--command", "DROP TRIGGER fixture_chat_notification_failure");
    };
    const removeInvitationMembership = async () => {
      assert.ok(invitationResponses, "Only invitation fixtures can remove this membership");
      assert.ok(!worker || worker.exitCode !== null || worker.signalCode !== null, "Stop the Worker before fixture mutation");
      await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state,
        "--command", "DELETE FROM member WHERE organizationId='display-other' AND userId='smoke-operator'");
    };
    const insertInboxArrival = async () => {
      assert.ok(notificationInbox, "Only the inbox fixture can insert this alert");
      assert.ok(!worker || worker.exitCode !== null || worker.signalCode !== null, "Stop the Worker before fixture mutation");
      await wrangler("d1", "execute", "showpilot-db", "--local", "--config", configPath, "--persist-to", state,
        "--command", "INSERT INTO notification(id,orgId,userId,type,severity,title,message,target,source,actionUrl,category,deviceAlertEnabled,dismissed,createdAt) VALUES('inbox-later','display-smoke','smoke-operator','fixture','info','Arrived after mark-all','Keep this alert unread.','','fixture','schedule','system',0,0,'2026-11-08T00:00:00.000Z')");
    };
    const configureEmail = async mode => {
      assert.ok(captureEmail && ["success", "fail", "lose-reply", "partial-schedule"].includes(mode));
      await writeFile(join(directory, "email-mode"), mode);
    };
    const configureStreamOutputs = async mode => {
      assert.ok(streamOutputs && ["success", "error", "slow", "malformed", ...(streamOutputs === "inputs" ? ["lose-create", "lose-delete", "lose-enable"] : streamOutputs === "commands" ? ["lose-create", "slow-create", "fail-delete"] : [])].includes(mode));
      await writeFile(join(directory, "stream-output-mode"), mode);
    };
    const streamOutputRequests = async () => {
      assert.ok(streamOutputs);
      return (await readFile(join(directory, "stream-output-requests.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    };
    const streamOutputSnapshot = async () => {
      assert.ok(streamOutputs === "commands" || streamOutputs === "inputs");
      return JSON.parse(await readFile(join(directory,"stream-output-snapshot.json"),"utf8"));
    };
    const capturedEmails = async () => {
      assert.ok(captureEmail);
      return (await readFile(join(directory, "emails.jsonl"), "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    };
    await check({ insertInboxArrival, configureStreamOutputs, streamOutputRequests, streamOutputSnapshot, removeInvitationMembership, restoreChatNotifications, configureEmail, capturedEmails, origin, orgId, date, browser, pass, crewChatPass, planningChatPass, stopServer, startServer, serverState: () => ({ exitCode: worker?.exitCode ?? null, signalCode: worker?.signalCode ?? null }), queryFixture, revokeFixtureOperator, repairGraphicSceneFixtures, unverifiedOperatorLink, resetTokens: passwordReset ? resetTokens : undefined, operatorCookie: cookie, operatorEmail: "operator@display-smoke.invalid", operatorPassword: password });
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
