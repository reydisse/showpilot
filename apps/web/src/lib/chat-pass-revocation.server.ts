import { inspectCrewChatPass } from "./chat-pass-token";
import { scopedTokenDigest } from "./scoped-token-store.server";

// Bind revocation to authenticated signing input, not the signature's base64
// spelling. Equivalent base64 encodings must not bypass a disabled link.
export function chatPassDigest(token: string): Promise<string> {
  return scopedTokenDigest(token.split(".").slice(0, 2).join("."));
}

/** The raw D1 binding uses primary reads. Never cache a revocation decision. */
export async function chatPassIsRevoked(db: D1Database, orgId: string, tokenHash: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 AS revoked FROM chat_pass_revocation WHERE orgId = ? AND tokenHash = ? LIMIT 1")
    .bind(orgId, tokenHash).first());
}

export async function chatTokenIsRevoked(db: D1Database, orgId: string, token: string): Promise<boolean> {
  return chatPassIsRevoked(db, orgId, await chatPassDigest(token));
}

/** Identical retries preserve the original actor/time. No bearer token is stored. */
export async function recordChatPassRevocation(db: D1Database, input: {
  orgId: string; token: string; scope: "crew-chat" | "planning-chat"; expiresAt: number; actorId: string;
}): Promise<string> {
  const tokenHash = await chatPassDigest(input.token);
  await db.prepare(`INSERT INTO chat_pass_revocation (orgId,tokenHash,scope,expiresAt,revokedAt,revokedBy)
    VALUES (?,?,?,?,?,?) ON CONFLICT(orgId,tokenHash) DO NOTHING`)
    .bind(input.orgId, tokenHash, input.scope, input.expiresAt, Date.now(), input.actorId).run();
  return tokenHash;
}

export async function verifyCrewChatPass(token: string, secret: string, db: D1Database) {
  const result = await inspectCrewChatPass(token, secret);
  return result.status === "valid" && !await chatTokenIsRevoked(db, result.pass.orgId, token) ? result.pass : null;
}
