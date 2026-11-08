import { getD1 } from "./d1";
import {
  crewLinkDenied,
  resolveCrewScheduleAccess,
} from "./crew-schedule-access.server";
import {
  writeAssignmentResponse,
  type ResponseWriteCommand,
} from "./assignment-response-write.server";
export async function writeCrewScheduleResponse(
  token: string,
  command: ResponseWriteCommand,
  review = false,
  db: Pick<D1Database, "prepare" | "batch"> = getD1(),
) {
  const access = await resolveCrewScheduleAccess(token, db);
  const actor = await db
    .prepare(
      `SELECT m.userId FROM member m JOIN user u ON u.id=m.userId
   JOIN crew_member c ON c.orgId=m.organizationId AND lower(c.email)=lower(u.email)
   WHERE c.orgId=? AND c.id=? LIMIT 1`,
    )
    .bind(access.orgId, access.crewMemberId)
    .first<{ userId: string }>();
  return writeAssignmentResponse(
    command,
    {
      kind: "portal",
      orgId: access.orgId,
      principalId: access.id,
      actorId: actor?.userId ?? null,
      crewMemberId: access.crewMemberId,
      guard: access.guard,
      guardArgs: access.guardArgs,
      denied: crewLinkDenied,
    },
    review,
    db,
  );
}
