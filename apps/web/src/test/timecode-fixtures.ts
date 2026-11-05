import { env } from "cloudflare:workers";
import { getShowTimecodeRelay, timecodeTargetUrl } from "@/lib/timecode-target.server";
import { seedRelayMember } from "./relay-fixtures";

/** Real D1 show plus the production room binding used by Worker tests. */
export async function timecodeFixture(orgId = `timecode-${crypto.randomUUID()}`, showId = `${orgId}-show`, claimControl = true) {
  const target = { orgId, showId, serviceDate: "2026-11-05" };
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO organization (id,name,slug,createdAt) VALUES (?,'Timecode fixture',?,CURRENT_TIMESTAMP)").bind(orgId, orgId),
    env.DB.prepare("INSERT OR IGNORE INTO rundown (id,orgId,serviceDate,name) VALUES (?,?,?,'Timecode fixture')").bind(showId, orgId, target.serviceDate),
    env.DB.prepare("INSERT OR IGNORE INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-show-id',?)").bind(crypto.randomUUID(), orgId, showId),
  ]);
  const stub = await getShowTimecodeRelay(env, target);
  const authority = await seedRelayMember(orgId);
  const url = (path: string, access = "write") => {
    const url = timecodeTargetUrl(target, path);
    url.searchParams.set("access", access);
    url.searchParams.set("authUserId", authority.userId);
    url.searchParams.set("authSessionId", authority.sessionId);
    return url;
  };
  const controlSocket = claimControl ? await claimTimecodeControl(stub, url("/ws")) : null;
  return { orgId, target, stub, url, authority, controlSocket };
}

/** Exercise real socket ownership before using the same-session HTTP endpoint. */
export async function claimTimecodeControl(stub: Pick<DurableObjectStub, "fetch">, url: URL) {
  const response = await stub.fetch(url, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new Error("Missing operator socket");
  const granted = new Promise<void>((resolve, reject) => {
    const receive = (message: MessageEvent) => {
      const data = JSON.parse(String(message.data));
      if (data.type === "control-status" && data.control === "yours") { socket.removeEventListener("message", receive); resolve(); }
      if (data.type === "command-rejected") { socket.removeEventListener("message", receive); reject(new Error(data.error)); }
    };
    socket.addEventListener("message", receive);
  });
  socket.accept();
  socket.send(JSON.stringify({ type: "command", action: "claim-control" }));
  await granted;
  return socket;
}

/** Fixture feeders follow the real Start -> feed contract, including after Stop. */
export async function startFixtureTimecodeFeed(stub: Pick<DurableObjectStub, "fetch">, url: (path: string) => URL) {
  const state = await (await stub.fetch(url("/state"))).json<{ signal?: { status: string } }>();
  if (state.signal?.status !== "idle") return;
  const response = await stub.fetch(url("/command"), { method: "POST", body: JSON.stringify({ action: "start" }) });
  if (!response.ok) throw new Error(`Fixture source could not start: ${response.status}`);
  await response.arrayBuffer();
}
