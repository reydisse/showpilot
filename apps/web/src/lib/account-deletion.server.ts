import { APIError } from "better-auth/api";
import { env } from "cloudflare:workers";
import { findAccountDeletionOwnershipBlockers, hasOrganizationRole } from "@/lib/account-deletion-core";
import { chatRelayKey } from "@/lib/chat-relay-key";
import { getD1 } from "@/lib/d1";
import { getPrisma } from "@/lib/db";

interface AccountDeletionEnv {
  BETTER_AUTH_SECRET?: string;
  CHAT_RELAY: DurableObjectNamespace;
  STORAGE: R2Bucket;
}

async function loadDeletionMemberships(userId: string) {
  return getPrisma().member.findMany({
    where: { userId },
    select: {
      role: true,
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          members: {
            where: { userId: { not: userId } },
            select: { userId: true, role: true },
          },
        },
      },
    },
  });
}

export async function getAccountDeletionOwnershipStatus(userId: string) {
  const memberships = await loadDeletionMemberships(userId);
  const blockers = findAccountDeletionOwnershipBlockers(memberships.map((membership) => ({
    role: membership.role,
    organization: {
      id: membership.organization.id,
      name: membership.organization.name,
      slug: membership.organization.slug,
    },
    otherMemberRoles: membership.organization.members.map((member) => member.role),
  })));
  return { blockers, memberships };
}

async function deleteNativeChatData(
  userId: string,
  memberships: Awaited<ReturnType<typeof loadDeletionMemberships>>,
): Promise<void> {
  const cfEnv = env as unknown as AccountDeletionEnv;
  if (!cfEnv.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is not configured");
  const roomKeys = new Set<string>();
  const indexedRooms = await getD1().prepare(
    "SELECT orgId, roomId FROM chat_user_room WHERE userId = ?",
  ).bind(userId).all<{ orgId: string; roomId: string }>();
  for (const room of indexedRooms.results) roomKeys.add(chatRelayKey(room.orgId, room.roomId));
  for (const membership of memberships) {
    const orgId = membership.organization.id;
    roomKeys.add(chatRelayKey(orgId, "production"));
    roomKeys.add(chatRelayKey(orgId, "planning"));
    for (const otherMember of membership.organization.members) {
      const roomId = `dm:${[userId, otherMember.userId].sort().join(":")}`;
      roomKeys.add(chatRelayKey(orgId, roomId));
    }
  }
  await Promise.all([...roomKeys].map(async (key) => {
    const stub = cfEnv.CHAT_RELAY.get(cfEnv.CHAT_RELAY.idFromName(key));
    const response = await stub.fetch(new Request("https://showpilot.internal/internal/delete-user-data", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-showpilot-internal-secret": cfEnv.BETTER_AUTH_SECRET!,
      },
      body: JSON.stringify({ userId }),
    }));
    if (!response.ok) throw new Error(`Native chat cleanup failed with status ${response.status}`);
  }));
}

async function deleteDatabaseUserContent(userId: string, email: string, emailVerified: boolean): Promise<void> {
  const db = getD1();
  await db.batch([
    // Crew profiles predate login accounts and link by verified email. Never
    // let an unverified signup erase a crew member who owns that address.
    db.prepare("UPDATE service_assignment SET responseNote = '', respondedAt = NULL WHERE crewMemberId IN (SELECT id FROM crew_member WHERE ? = 1 AND lower(trim(email)) = lower(?))").bind(emailVerified ? 1 : 0, email),
    db.prepare("DELETE FROM crew_member WHERE ? = 1 AND lower(trim(email)) = lower(?)").bind(emailVerified ? 1 : 0, email),
    db.prepare("UPDATE service_assignment SET assignedByUserId = NULL WHERE assignedByUserId = ?").bind(userId),
    db.prepare("DELETE FROM app_setting WHERE key IN (?, ?, ?)").bind(`notification-timezone:${userId}`, `onboarding-role:${userId}`, `onboarding-first-session:${userId}`),
    db.prepare("DELETE FROM invitation WHERE ? = 1 AND lower(email) = lower(?)").bind(emailVerified ? 1 : 0, email),
    db.prepare("DELETE FROM push_subscription WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM chat_user_room WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM content_reaction WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM notification WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM incident_comment WHERE userId = ?").bind(userId),
    db.prepare("UPDATE incident SET assignedBy = NULL WHERE assignedBy = ?").bind(userId),
    db.prepare("UPDATE incident SET assignedTo = NULL, assignedName = '', acknowledgedAt = NULL, assignedAt = NULL WHERE assignedTo = ?").bind(userId),
    db.prepare("UPDATE kiosk_token SET createdBy = 'deleted-account' WHERE createdBy = ?").bind(userId),
    db.prepare("UPDATE companion_token SET createdBy = 'deleted-account' WHERE createdBy = ?").bind(userId),
    db.prepare("DELETE FROM verification WHERE identifier = ? OR value = ?").bind(email, userId),
  ]);
}

async function deleteUploadedChatFiles(userId: string, orgIds: Set<string>): Promise<void> {
  // Include uploads that were never sent as messages. Their uploader metadata
  // is authoritative; filenames and display names cannot establish ownership.
  for (const orgId of orgIds) {
    let cursor: string | undefined;
    do {
      const listing = await env.STORAGE.list({ prefix: `orgs/${orgId}/chat/`, cursor, include: ["customMetadata"] });
      const keys = listing.objects.filter((object) => object.customMetadata?.uploadedBy === userId).map((object) => object.key);
      if (keys.length > 0) await env.STORAGE.delete(keys);
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }
}

async function preserveOrganizationAuditLinks(
  userId: string,
  memberships: Awaited<ReturnType<typeof loadDeletionMemberships>>,
): Promise<void> {
  const db = getD1();
  const statements = memberships.flatMap((membership) => {
    const replacementOwner = membership.organization.members.find((member) =>
      hasOrganizationRole(member.role, "owner"),
    );
    if (!replacementOwner) return [];
    return [
      db.prepare("UPDATE member_permission_grant SET grantedByUserId = ? WHERE orgId = ? AND grantedByUserId = ?")
        .bind(replacementOwner.userId, membership.organization.id, userId),
      db.prepare("UPDATE invitation SET inviterId = ? WHERE organizationId = ? AND inviterId = ?")
        .bind(replacementOwner.userId, membership.organization.id, userId),
    ];
  });
  if (statements.length > 0) await db.batch(statements);
}

export async function beforeDeleteAccount(user: { id: string; email: string; emailVerified: boolean }): Promise<void> {
  const { blockers, memberships } = await getAccountDeletionOwnershipStatus(user.id);
  if (blockers.length > 0) {
    throw new APIError("BAD_REQUEST", {
      message: `Transfer ownership or delete these workspaces first: ${blockers.map((blocker) => blocker.name).join(", ")}`,
    });
  }

  // Every operation is idempotent. If an external storage call fails, Better
  // Auth keeps the user row. Password confirmation allows the same request
  // to be retried without consuming a one-time email token.
  const indexedRooms = await getD1().prepare("SELECT DISTINCT orgId FROM chat_user_room WHERE userId = ?").bind(user.id).all<{ orgId: string }>();
  const orgIds = new Set([...memberships.map((m) => m.organization.id), ...indexedRooms.results.map((r) => r.orgId)]);
  await deleteNativeChatData(user.id, memberships);
  await deleteUploadedChatFiles(user.id, orgIds);
  const cfEnv = env as unknown as AccountDeletionEnv;
  await cfEnv.STORAGE.delete(`avatars/${user.id}.jpg`);
  await preserveOrganizationAuditLinks(user.id, memberships);
  await deleteDatabaseUserContent(user.id, user.email, user.emailVerified);
}
