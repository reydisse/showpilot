import { env } from "cloudflare:workers";
import { getD1 } from "./d1";
import { CredentialVault } from "./credential-vault.server";
import { markDatabaseWrite } from "./request-database.server";

type DestinationFields = { name: string; platform: string; rtmpUrl: string; streamKey: string };
type DestinationCommand = { orgId: string; actorId: string; requestId?: string } & (
  | { kind: "create"; fields: DestinationFields }
  | { kind: "update"; id: string; fields: Partial<DestinationFields> }
);
type StoredDestination = DestinationFields & { id: string; enabled: number; cfOutputId: string; liveInputId: string };

/** Existing plaintext keys remain readable until replaced; new keys fail closed without the vault. */
export async function readStreamDestinationKey(destination: { id: string; orgId: string; streamKey: string }): Promise<string> {
  if (!destination.streamKey.startsWith("spenc:")) return destination.streamKey;
  const vault = await CredentialVault.fromSecret(env.CREDENTIAL_ENCRYPTION_KEYS);
  return vault.decrypt({ kind: "stream-destination", orgId: destination.orgId, destinationId: destination.id }, destination.streamKey);
}
async function storedKey(orgId: string, id: string, replacement: string | undefined, previous = ""): Promise<string> {
  if (!replacement?.trim()) return previous;
  const vault = await CredentialVault.fromSecret(env.CREDENTIAL_ENCRYPTION_KEYS);
  return vault.encrypt({ kind: "stream-destination", orgId, destinationId: id }, replacement.trim());
}
async function fingerprint(command: DestinationCommand, requestId: string): Promise<string> {
  if (!env.BETTER_AUTH_SECRET) throw new Error("Destination retry confirmation is unavailable.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = ["showpilot-stream-destination-write-v1", command.orgId, command.actorId, requestId,
    command.kind, command.kind === "update" ? command.id : null, command.fields];
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(body)));
  return "hmac-sha256:" + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,"0")).join("");
}

/** Callers validate fields and check current stream_health:manage authority before every attempt. */
export async function saveStreamDestinationForOrg(command: DestinationCommand): Promise<string> {
  const db = getD1();
  const requestId = command.requestId ?? crypto.randomUUID();
  const digest = await fingerprint(command,requestId);
  const readReceipt = () => db.prepare("SELECT fingerprint,destinationId FROM stream_destination_write_receipt WHERE orgId=? AND actorId=? AND requestId=?")
    .bind(command.orgId,command.actorId,requestId).first<{ fingerprint: string; destinationId: string }>();
  const recover = (receipt: NonNullable<Awaited<ReturnType<typeof readReceipt>>>) => {
    if (receipt.fingerprint !== digest) throw new Error("This request belongs to different destination changes. Review stored destinations before editing again.");
    return receipt.destinationId;
  };
  const previous = await readReceipt();
  if (previous) return recover(previous);
  let prepared = false;
  try {
    let id: string, guard: string, guardValues: (string | number)[], mutation: D1PreparedStatement;
    if (command.kind === "create") {
      id = crypto.randomUUID();
      const key = await storedKey(command.orgId,id,command.fields.streamKey);
      if (!key) throw new Error("A stream key is required for a new destination.");
      guard = "1"; guardValues = [];
      mutation = db.prepare("INSERT INTO stream_destination(id,orgId,name,platform,rtmpUrl,streamKey,enabled) VALUES(?,?,?,?,?,?,0)")
        .bind(id,command.orgId,command.fields.name,command.fields.platform,command.fields.rtmpUrl,key);
    } else {
      id = command.id;
      const existing = await db.prepare("SELECT id,name,platform,rtmpUrl,streamKey,enabled,cfOutputId,liveInputId FROM stream_destination WHERE id=? AND orgId=?")
        .bind(id,command.orgId).first<StoredDestination>();
      if (!existing) throw new Error("Destination not found.");
      const changesCredentials = (command.fields.rtmpUrl !== undefined && command.fields.rtmpUrl !== existing.rtmpUrl) || Boolean(command.fields.streamKey?.trim());
      if (changesCredentials && existing.cfOutputId) throw new Error("Disable this destination before changing its RTMP credentials.");
      const key = await storedKey(command.orgId,id,command.fields.streamKey,existing.streamKey);
      guard = "EXISTS(SELECT 1 FROM stream_destination WHERE id=? AND orgId=? AND name=? AND platform=? AND rtmpUrl=? AND streamKey=? AND enabled=? AND cfOutputId=? AND liveInputId=?)";
      guardValues = [id,command.orgId,existing.name,existing.platform,existing.rtmpUrl,existing.streamKey,existing.enabled,existing.cfOutputId,existing.liveInputId];
      mutation = db.prepare("UPDATE stream_destination SET name=?,platform=?,rtmpUrl=?,streamKey=? WHERE id=? AND orgId=?")
        .bind(command.fields.name ?? existing.name,command.fields.platform ?? existing.platform,command.fields.rtmpUrl ?? existing.rtmpUrl,key,id,command.orgId);
    }
    prepared = true;
    markDatabaseWrite();
    await db.batch([
      db.prepare(`INSERT INTO stream_destination_write_receipt(orgId,actorId,requestId,fingerprint,destinationId,createdAt,precondition)
        VALUES(?,?,?,?,?,?,CASE WHEN ${guard} THEN 1 ELSE 0 END)`)
        .bind(command.orgId,command.actorId,requestId,digest,id,new Date().toISOString(),...guardValues),
      mutation,
    ]);
    return id;
  } catch (error) {
    const saved = await readReceipt();
    if (saved) return recover(saved);
    if (!prepared) throw error;
    if (error instanceof Error && error.message.includes("stream_destination_write_precondition")) throw new Error("This destination changed elsewhere. Review stored destinations before retrying.");
    throw new Error("The destination save could not be confirmed. Retry the same change.", { cause: error });
  }
}
