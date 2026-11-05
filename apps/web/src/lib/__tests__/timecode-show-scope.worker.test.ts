import { claimTimecodeControl, startFixtureTimecodeFeed } from "@/test/timecode-fixtures";
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { getShowTimecodeRelay, resolveTimecodeTarget, timecodeRelayKey, timecodeTargetUrl, type TimecodeTarget } from "../timecode-target.server";
import type { AutomationEvent, TimecodeState } from "@/types/timecode";
import { openTestBridge } from "@/test/bridge-fixtures";
import { seedRelayMember } from "@/test/relay-fixtures";

afterEach(() => abortAllDurableObjects());
async function shows() {
  const orgId = `shows-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO organization (id,name,slug,createdAt) VALUES (?,'Clock fixture',?,CURRENT_TIMESTAMP)").bind(orgId,orgId).run();
  const targets = ["morning", "evening"].map(name => ({ orgId, showId: `${orgId}-${name}`, serviceDate: "2026-11-05" }));
  for (const target of targets) await env.DB.prepare("INSERT INTO rundown (id,orgId,serviceDate,name) VALUES (?,?,?,'Clock fixture')").bind(target.showId,orgId,target.serviceDate).run();
  await env.DB.prepare("INSERT INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-show-id',?)").bind(crypto.randomUUID(),orgId,targets[0].showId).run();
  return targets;
}
async function room(target: TimecodeTarget) {
  const stub = await getShowTimecodeRelay(env, target);
  const authority = await seedRelayMember(target.orgId);
  const url = (path: string) => {
    const url = timecodeTargetUrl(target, path);
    url.searchParams.set("access", "write");
    url.searchParams.set("authUserId", authority.userId);
    url.searchParams.set("authSessionId", authority.sessionId);
    return url;
  };
  let controller: WebSocket | null = null;
  return {
    stub, url,
    async command(action: string, payload?: Record<string, unknown>) {
      controller ??= await claimTimecodeControl(stub, url("/ws"));
      if (action === "feed-tc") await startFixtureTimecodeFeed(stub, url);
      const response = await stub.fetch(new Request(url("/command"), {
        method: "POST", body: JSON.stringify({ action, payload }),
      }));
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    },
    async state() { return (await stub.fetch(url("/state"))).json<TimecodeState>(); },
    async events() { return (await stub.fetch(url("/events"))).json<AutomationEvent[]>(); },
  };
}
const cue = {
  id: "cue", label: "Own show only", action: "stage-message",
  triggerTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
  payload: { message: "Morning cue" }, toleranceFrames: 2,
};

describe("show-scoped timecode rooms", () => {
  it("keeps a rescheduled show's clock and prevents an old Bridge date from reverting its metadata", async () => {
    const [a] = await shows();
    const morning = await room(a);
    await morning.command("add-event", cue);
    const rescheduled = { ...a, serviceDate: "2026-11-06" };
    await env.DB.prepare("UPDATE rundown SET serviceDate=? WHERE orgId=? AND id=?").bind(rescheduled.serviceDate, a.orgId, a.showId).run();
    const reopened = await room(rescheduled);
    expect((await reopened.events())[0].id).toBe("cue");
    expect(await morning.stub.bindShow(a)).toEqual({ ok: true });
    expect(await reopened.state()).toMatchObject({ showId: a.showId, serviceDate: rescheduled.serviceDate });
  });

  it("rejects legacy writes even before any show has migrated", async () => {
    const legacy = env.TIMECODE_RELAY.getByName(`unbound-${crypto.randomUUID()}`);
    const response = await legacy.fetch("https://test/command?orgId=unbound&access=write", {
      method: "POST", body: JSON.stringify({ action: "start" }),
    });
    expect(response.status).toBe(409);
  });

  it("retires a deleted show across hibernation and rejects late Bridge feeds and re-binding", async () => {
    const [a, b] = await shows();
    const morning = await room(a);
    const evening = await room(b);
    await morning.command("add-event", cue);
    await evening.command("add-event", { ...cue, label: "Evening cue" });
    const retire = async (target: TimecodeTarget) => {
      const response = await morning.stub.fetch(timecodeTargetUrl(target, "/internal/purge-show"), {
        method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
      });
      await response.arrayBuffer();
      return response;
    };
    expect((await retire(b)).status).toBe(409);
    expect((await retire(a)).status).toBe(200);
    await evictDurableObject(morning.stub);
    expect(await env.TIMECODE_RELAY.getByName(timecodeRelayKey(a)).bindShow(a)).toMatchObject({ ok: false, error: expect.stringContaining("retired") });
    expect((await morning.stub.fetch(timecodeTargetUrl(a, "/internal/bridge-feed"), {
      method: "POST", headers: { "x-showpilot-internal-secret": env.BETTER_AUTH_SECRET },
      body: JSON.stringify({ payload: { timecode: cue.triggerTimecode, format: { frameRate: 30, dropFrame: "ndf" } } }),
    })).status).toBe(410);
    expect((await evening.events())[0]).toMatchObject({ label: "Evening cue", fired: false });
    await runInDurableObject(morning.stub, async (_instance, ctx) => {
      expect(await ctx.storage.list()).toEqual(new Map([["retired", true]]));
    });
  });

  it("keeps a Bridge feed pinned through active-show changes and hibernation, and stops only its own clock", async () => {
    const [a, b] = await shows();
    const morning = await room(a);
    const evening = await room(b);
    const bridge = await openTestBridge(a.orgId);
    expect(await bridge.stub.getBridgeStatus()).toMatchObject({ timecodeTarget: a });
    await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key='active-show-id'").bind(b.showId, a.orgId).run();
    await evictDurableObject(bridge.stub);
    const feed = { type: "timecode-feed", timecode: cue.triggerTimecode, format: { frameRate: 30, dropFrame: "ndf" } };
    bridge.socket.send(JSON.stringify(feed));
    await expect.poll(async () => (await morning.state()).totalFrames).toBe(30);
    expect(await evening.state()).toMatchObject({ totalFrames: 0, running: false });
    await evening.command("start");
    bridge.socket.close();
    await expect.poll(async () => (await morning.state()).running).toBe(false);
    expect(await evening.state()).toMatchObject({ running: true });
  });

  it("accepts only valid internal Bridge feeds and leaves an operator's clock in control", async () => {
    const [a] = await shows();
    const morning = await room(a);
    const feed = (path: string, secret = env.BETTER_AUTH_SECRET, payload: unknown = {
      timecode: cue.triggerTimecode, format: { frameRate: 30, dropFrame: "ndf" },
    }) => morning.stub.fetch(timecodeTargetUrl(a, path), {
      method: "POST", headers: { "x-showpilot-internal-secret": secret }, body: JSON.stringify({ payload }),
    });
    expect((await feed("/internal/bridge-feed", "wrong")).status).toBe(401);
    expect((await feed("/internal/bridge-feed", env.BETTER_AUTH_SECRET, {
      timecode: { hours: 0, minutes: 1, seconds: 0, frames: 0 }, format: { frameRate: 29.97, dropFrame: "df" },
    })).status).toBe(400);
    expect(await morning.state()).toMatchObject({ running: false, totalFrames: 0 });
    const url = morning.url("/ws");
    const response = await morning.stub.fetch(url, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket;
    if (!socket) throw new Error("Missing operator socket");
    socket.accept();
    socket.send(JSON.stringify({ type: "command", action: "start" }));
    await expect.poll(async () => (await morning.state()).running).toBe(true);
    // Valid feeds remain standby data while the operator is master.
    expect((await feed("/internal/bridge-feed")).status).toBe(200);
    expect(await morning.state()).toMatchObject({ running: true, totalFrames: 0, source: "internal-freerun" });
    expect((await feed("/internal/bridge-disconnected")).status).toBe(200);
    expect(await morning.state()).toMatchObject({ running: true, totalFrames: 0, source: "internal-freerun" });
    socket.close();
  });

  it("migrates concurrent first connections once and leaves an interrupted cue for explicit review", async () => {
    const [a, b] = await shows();
    const legacy = env.TIMECODE_RELAY.getByName(a.orgId);
    const state: TimecodeState = {
      timecode: cue.triggerTimecode, display: "00:00:01:00", source: "mtc",
      format: { frameRate: 30, dropFrame: "ndf" }, running: true, totalFrames: 30,
      serverTime: 1, triggersEnabled: true, lyrics: null,
    };
    await runInDurableObject(legacy, async (_instance, ctx) => {
      await ctx.storage.put("timecode", { state, events: [{ ...cue, triggerFrame: 30, fired: false, executionStatus: "dispatching" }] });
    });
    await evictDurableObject(legacy);
    const [morning, evening] = await Promise.all([room(a), room(b)]);
    expect(await morning.events()).toEqual([expect.objectContaining({ executionStatus: "failed", executionAttempts: 3, fired: false })]);
    expect(await morning.state()).toMatchObject({ running: false, triggersEnabled: false });
    expect(await evening.events()).toEqual([]);
  });

  it("keeps same-day clocks and cues separate and never retargets a cue to the newly active show", async () => {
    const [a,b] = await shows();
    const morning = await room(a); const evening = await room(b);
    await morning.command("add-event",cue);
    await evening.command("set-timecode",{timecode:{hours:1,minutes:0,seconds:0,frames:0}});
    await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key='active-show-id'").bind(b.showId,a.orgId).run();
    await morning.command("feed-tc",{timecode:cue.triggerTimecode,format:{frameRate:30,dropFrame:"ndf"}});
    expect(await morning.state()).toMatchObject({showId:a.showId,totalFrames:30});
    expect(await evening.state()).toMatchObject({showId:b.showId,totalFrames:108000});
    expect(await evening.events()).toEqual([]);
    expect(await morning.events()).toEqual([expect.objectContaining({fired:true,executionStatus:"acknowledged"})]);
    for (const [target,expected] of [[a,"Morning cue"],[b,""]] as const) {
      const query = new URLSearchParams({orgId:target.orgId,showId:target.showId,serviceDate:target.serviceDate,access:"observe"});
      const response = await env.RUNDOWN_RELAY.getByName(timecodeRelayKey(target)).fetch(`https://test/state?${query}`);
      expect(await response.json()).toMatchObject({stageMessage:expected});
    }
    // A format change must not make the acknowledged cue eligible again.
    await morning.command("set-format",{format:{frameRate:25,dropFrame:"ndf"}});
    expect(await morning.events()).toEqual([expect.objectContaining({fired:true,executionStatus:"acknowledged"})]);
    await morning.command("feed-tc",{timecode:cue.triggerTimecode,format:{frameRate:30,dropFrame:"ndf"}});
    expect(await morning.events()).toEqual([expect.objectContaining({fired:true,executionAttempts:1})]);
    await evictDurableObject(morning.stub);
    expect(await morning.state()).toMatchObject({showId:a.showId});
    const wrong = timecodeTargetUrl(b,"/command"); wrong.searchParams.set("access","write");
    expect((await morning.stub.fetch(new Request(wrong,{method:"POST",body:JSON.stringify({action:"feed-tc",payload:{}})}))).status).toBe(409);
    expect(await morning.stub.bindShow(b)).toEqual({ ok: false, error: "Timecode room belongs to another show" });
  });

  it("assigns a legacy timeline once, even when the other show connects first and active selection changes", async () => {
    const [a,b] = await shows();
    const legacy=env.TIMECODE_RELAY.getByName(a.orgId);
    const state: TimecodeState={timecode:cue.triggerTimecode,display:"00:00:01:00",source:"internal-freerun",format:{frameRate:30,dropFrame:"ndf"},running:true,totalFrames:30,serverTime:1,triggersEnabled:true,lyrics:null};
    await runInDurableObject(legacy,async (_instance,storage)=>{
      await storage.storage.put("timecode",{state,events:[{...cue,triggerFrame:30,fired:true,executionStatus:"acknowledged"}]});
    });
    await evictDurableObject(legacy);
    const evening=await room(b);
    expect(await evening.events()).toEqual([]);
    expect(await evening.state()).toMatchObject({triggersEnabled:true});
    await env.DB.prepare("UPDATE app_setting SET value=? WHERE orgId=? AND key='active-show-id'").bind(b.showId,a.orgId).run();
    const morning=await room(a);
    expect(await morning.state()).toMatchObject({showId:a.showId,running:false,triggersEnabled:false,totalFrames:30});
    expect(await morning.events()).toEqual([expect.objectContaining({id:"cue",fired:true})]);
    await morning.command("remove-event",{id:"cue"});
    await evictDurableObject(morning.stub);
    await morning.stub.bindShow(a);
    expect(await morning.events()).toEqual([]);
    expect((await legacy.fetch(`https://test/command?orgId=${a.orgId}`,{method:"POST",body:'{"action":"start"}'})).status).toBe(409);
  });

  it("does not resolve another organization's or deleting show's identity", async()=>{
    const [a,b]=await shows();
    expect(await resolveTimecodeTarget(env.DB,"other",a.showId)).toBeNull();
    await env.DB.prepare("INSERT INTO app_setting(id,orgId,key,value) VALUES(?,?,?,'true')").bind(crypto.randomUUID(),b.orgId,`show-deleting:${b.showId}`).run();
    expect(await resolveTimecodeTarget(env.DB,b.orgId,b.showId)).toBeNull();
  });
});
