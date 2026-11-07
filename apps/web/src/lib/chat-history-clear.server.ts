import { env } from "cloudflare:workers";
import { getD1 } from "./d1";
import { hasPermission } from "./app-permissions";
import { chatRelayKey } from "./chat-relay-key";
import { withOperationTimeout } from "./operation-timeout";
import {
  chatClearReceiptSchema,
  type ChatHistoryClear,
  type ChatHistoryClearResult,
  type ChatRoomClear,
} from "./chat-history-clear-contract";
import type { LiveSessionAuthorityClaim } from "./live-rundown-authority.server";
export type ChatClearDatabase = Pick<D1Database, "prepare" | "batch">;

const activeSession = `(CASE WHEN typeof(s.expiresAt) IN ('integer','real') THEN s.expiresAt ELSE (julianday(s.expiresAt)-2440587.5)*86400000 END)>(julianday('now')-2440587.5)*86400000`;

/** The receipt fixes the rooms/cutoff once. A retry only finishes the same clear. */
export async function clearOrganizationChat({
  command,
  authority,
  database = getD1(),
  clearRoom = (input) =>
    env.CHAT_RELAY.getByName(
      chatRelayKey(input.orgId, input.roomId),
    ).clearHistory(input),
}: {
  command: ChatHistoryClear;
  authority: LiveSessionAuthorityClaim;
  database?: ChatClearDatabase;
  clearRoom?: (input: ChatRoomClear) => Promise<{ cleared: boolean }>;
}): Promise<ChatHistoryClearResult> {
  if (command.orgId !== authority.orgId)
    throw new Error("Organization mismatch.");
  const member = await database
    .prepare(
      `SELECT m.id,m.role,m.managementRevision,o.name FROM member m JOIN organization o ON o.id=m.organizationId JOIN session s ON s.userId=m.userId
    WHERE m.organizationId=? AND m.userId=? AND s.id=? AND ${activeSession}`,
    )
    .bind(command.orgId, authority.userId, authority.sessionId)
    .first<{
      id: string;
      role: string;
      managementRevision: number;
      name: string;
    }>();
  if (!member || !hasPermission(member.role, "settings:danger_zone"))
    throw new Error(
      "You no longer have permission to clear this organization's chat history.",
    );
  const guard = `EXISTS(SELECT 1 FROM member m JOIN session s ON s.userId=m.userId WHERE m.organizationId=? AND m.id=? AND m.userId=? AND m.role=? AND m.managementRevision=? AND s.id=? AND ${activeSession})`;
  const guardArgs = [
    command.orgId,
    member.id,
    authority.userId,
    member.role,
    member.managementRevision,
    authority.sessionId,
  ];
  const receiptArgs = [command.orgId, authority.userId, command.requestId];
  const readReceipt = () =>
    database
      .prepare(
        `SELECT confirmName,cutoff,rooms FROM chat_history_clear_receipt WHERE orgId=? AND actorId=? AND requestId=? AND ${guard}`,
      )
      .bind(...receiptArgs, ...guardArgs)
      .first();
  let row = await readReceipt();
  if (!row) {
    if (command.confirmName !== member.name)
      throw new Error(
        "Type the organization's exact name to clear its chat history.",
      );
    const indexed = await database
      .prepare("SELECT DISTINCT roomId FROM chat_user_room WHERE orgId=?")
      .bind(command.orgId)
      .all<{ roomId: string }>();
    const rooms = [
      ...new Set([
        "production",
        "planning",
        ...(indexed.results ?? []).map((row) => row.roomId),
      ]),
    ].sort();
    const claimId = crypto.randomUUID();
    const cutoff = Date.now();
    await database.batch([
      database
        .prepare(
          `INSERT OR IGNORE INTO chat_history_clear_receipt(orgId,actorId,requestId,confirmName,claimId,cutoff,rooms)
        SELECT ?,?,?,?,?,?,? WHERE ${guard} AND EXISTS(SELECT 1 FROM organization WHERE id=? AND name=?)`,
        )
        .bind(
          ...receiptArgs,
          command.confirmName,
          claimId,
          cutoff,
          JSON.stringify(rooms),
          ...guardArgs,
          command.orgId,
          command.confirmName,
        ),
      // Only the invocation that created the receipt can delete legacy rows.
      database
        .prepare(
          `DELETE FROM chat_message WHERE orgId=? AND ${guard} AND EXISTS(SELECT 1 FROM chat_history_clear_receipt WHERE orgId=? AND actorId=? AND requestId=? AND claimId=?)`,
        )
        .bind(command.orgId, ...guardArgs, ...receiptArgs, claimId),
    ]);
    row = await readReceipt();
  }
  if (!row)
    throw new Error(
      "Your access or organization changed. Review it before clearing chat history.",
    );
  const receipt = chatClearReceiptSchema.parse(row);
  if (receipt.confirmName !== command.confirmName)
    throw new Error("This request already refers to a different confirmation.");
  const results = receipt.rooms.map((roomId) => ({ roomId, cleared: false }));
  const deadline = Date.now() + 7_000;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, results.length) }, async () => {
      while (cursor < results.length && Date.now() < deadline) {
        const result = results[cursor++];
        try {
          const response = await withOperationTimeout(
            clearRoom({
              ...command,
              roomId: result.roomId,
              authority,
              deadline,
            }),
            Math.min(5_000, Math.max(1, deadline - Date.now())),
            "Chat room clear was not confirmed.",
          );
          result.cleared = response.cleared;
        } catch {
          /* The response reports this room as pending; retry retains the receipt. */
        }
      }
    }),
  );
  return {
    requestId: command.requestId,
    cutoff: receipt.cutoff,
    rooms: results,
  };
}
