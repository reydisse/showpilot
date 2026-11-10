import { env } from "cloudflare:workers";
import { getD1 } from "./d1";
import { markDatabaseWrite } from "./request-database.server";

interface DeviceWrite {
  orgId: string;
  actorId: string;
  requestId?: string;
  kind: "create" | "update" | "delete";
  payload: unknown;
}
interface DeviceWritePlan {
  deviceId: string;
  guard: string;
  guardValues: (string | number | null)[];
  statement: D1PreparedStatement;
}

// A plain payload hash would expose low-entropy credentials to offline guesses
// by a database reader. The existing authentication secret keys this separate
// purpose; neither the request payload nor a plain credential digest is stored.
async function fingerprint(command: DeviceWrite, requestId: string): Promise<string> {
  if (!env.BETTER_AUTH_SECRET) throw new Error("Device retry confirmation is unavailable.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify([
    "showpilot-device-write-v1", command.orgId, command.actorId, requestId, command.kind, command.payload,
  ])));
  return "hmac-sha256:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** The caller checks current devices:access permission before every attempt. */
export async function runDeviceWrite(command: DeviceWrite, plan: () => Promise<DeviceWritePlan> | DeviceWritePlan): Promise<string> {
  const db = getD1();
  const requestId = command.requestId ?? crypto.randomUUID();
  const digest = await fingerprint(command, requestId);
  const read = () => db.prepare("SELECT fingerprint,deviceId FROM device_write_receipt WHERE orgId=? AND actorId=? AND requestId=?")
    .bind(command.orgId, command.actorId, requestId).first<{ fingerprint: string; deviceId: string }>();
  const recover = (receipt: NonNullable<Awaited<ReturnType<typeof read>>>) => {
    if (receipt.fingerprint !== digest) throw new Error("This request belongs to different device changes. Review the stored configuration before editing again.");
    return receipt.deviceId;
  };
  const previous = await read();
  if (previous) return recover(previous);
  let prepared = false;
  try {
    const next = await plan();
    prepared = true;
    markDatabaseWrite();
    await db.batch([
      db.prepare(`INSERT INTO device_write_receipt(orgId,actorId,requestId,fingerprint,deviceId,createdAt,precondition)
        VALUES(?,?,?,?,?,?,CASE WHEN ${next.guard} THEN 1 ELSE 0 END)`)
        .bind(command.orgId, command.actorId, requestId, digest, next.deviceId, new Date().toISOString(), ...next.guardValues),
      next.statement,
    ]);
    return next.deviceId;
  } catch (error) {
    // Also recover races where the winning creation reached the plan cap while
    // this duplicate was preparing. Replaying a receipt never consumes capacity.
    const saved = await read();
    if (saved) return recover(saved);
    if (!prepared) throw error;
    if (error instanceof Error && error.message.includes("device_write_precondition")) throw new Error("Device changed elsewhere. Review the stored devices and retry.");
    throw new Error("The device change could not be confirmed. Retry the same action.", { cause: error });
  }
}
