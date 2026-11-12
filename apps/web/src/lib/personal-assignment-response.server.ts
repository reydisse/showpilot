import { writeAssignmentResponse } from "./assignment-response-write.server";
import { getAuth } from "./auth";
import { getD1 } from "./d1";
import { memberPermissionGuard } from "./member-permission-guard.server";
import type {
  PersonalResponseCommand,
  PersonalResponseResult,
} from "./personal-assignment-response-contract";

type Database = Pick<D1Database, "prepare" | "batch">;
type Command = Omit<PersonalResponseCommand, "expectedRevision"> & {
  expectedRevision: string | null;
};
const denied = () =>
  new Error(
    "Your account changed. Sign in to the original account to recover this response.",
  );
/** Legacy clients lack a request identity; they still receive atomic checks.
 * Current clients supply a stable UUID and can recover or cancel a delayed write. */
export async function writePersonalAssignmentResponse(
  headers: Headers,
  command: Command,
  review = false,
  db: Database = getD1(),
): Promise<PersonalResponseResult> {
  const { orgId, userId } = command;
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session || session.user.id !== userId) throw denied();
  const access = await memberPermissionGuard(
    db,
    orgId,
    { userId, sessionId: session.session.id },
    [],
  );
  const email = session.user.email.toLowerCase();
  const guard = `${access.guard} AND EXISTS(SELECT 1 FROM user WHERE id=? AND lower(email)=?)`;
  const guardArgs = [...access.guardArgs, userId, email];
  const result = await writeAssignmentResponse(
    command,
    {
      kind: "member",
      orgId,
      principalId: userId,
      actorId: userId,
      email,
      guard,
      guardArgs,
      denied: denied().message,
    },
    review,
    db,
  );
  return { orgId, userId, ...result };
}
