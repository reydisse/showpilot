import { env } from "cloudflare:workers";
import { getShowTimecodeRelay, timecodeTargetUrl } from "@/lib/timecode-target.server";

/** Real D1 show plus the production room binding used by Worker tests. */
export async function timecodeFixture(orgId = `timecode-${crypto.randomUUID()}`, showId = `${orgId}-show`) {
  const target = { orgId, showId, serviceDate: "2026-11-05" };
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO organization (id,name,slug,createdAt) VALUES (?,'Timecode fixture',?,CURRENT_TIMESTAMP)").bind(orgId, orgId),
    env.DB.prepare("INSERT OR IGNORE INTO rundown (id,orgId,serviceDate,name) VALUES (?,?,?,'Timecode fixture')").bind(showId, orgId, target.serviceDate),
    env.DB.prepare("INSERT OR IGNORE INTO app_setting (id,orgId,key,value) VALUES (?,?,'active-show-id',?)").bind(crypto.randomUUID(), orgId, showId),
  ]);
  const stub = await getShowTimecodeRelay(env, target);
  const url = (path: string, access = "write") => {
    const url = timecodeTargetUrl(target, path);
    url.searchParams.set("access", access);
    return url;
  };
  return { orgId, target, stub, url };
}
