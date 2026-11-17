export async function recordScopedTokenAudit(db: D1Database, input: {
  orgId: string;
  tokenId: string;
  kind: "kiosk" | "companion";
  action: "created" | "revoked";
  actorUserId: string | null;
}): Promise<void> {
  await db.prepare(`INSERT INTO scoped_token_audit
    (id, orgId, tokenId, kind, action, actorUserId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.orgId, input.tokenId, input.kind,
      input.action, input.actorUserId, Date.now()).run();
}
