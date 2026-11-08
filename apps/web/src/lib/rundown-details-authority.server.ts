import { memberPermissionGuard } from "./member-permission-guard.server";
import { roleRequiresRundownPin } from "./permissions";
import { RUNDOWN_PIN_SETTING_KEY } from "./rundown-pin";
import { verifyStoredRundownPin } from "./rundown-pin-crypto";
export class RundownDetailsAccessError extends Error {}

/** Rundown editing has its own permission and PIN policy. Bind both the reviewed
 * role and PIN setting into the final SQL guard so a rotation cannot race a save. */
export async function rundownDetailsAuthority(
  db: Pick<D1Database, "prepare">,
  orgId: string,
  actor: { userId: string; sessionId: string },
  pin: string | null,
) {
  const member = await db
    .prepare("SELECT role FROM member WHERE organizationId=? AND userId=?")
    .bind(orgId, actor.userId)
    .first<{ role: string }>();
  if (!member)
    throw new RundownDetailsAccessError(
      "Your rundown editing authority is no longer active.",
    );
  const usesPin = roleRequiresRundownPin(member.role);
  const storedPin = usesPin
    ? ((
        await db
          .prepare("SELECT value FROM app_setting WHERE orgId=? AND key=?")
          .bind(orgId, RUNDOWN_PIN_SETTING_KEY)
          .first<{ value: string | null }>()
      )?.value ?? "")
    : "";
  const pinRequired = usesPin && !!storedPin.trim();
  if (pinRequired && !(await verifyStoredRundownPin(pin, storedPin)))
    throw new RundownDetailsAccessError(
      "Unlock this rundown with the current PIN before editing its details.",
    );
  const access = await memberPermissionGuard(
    db,
    orgId,
    actor,
    pinRequired ? [] : ["rundown:edit"],
  ).catch(() => {
    throw new RundownDetailsAccessError(
      "Your session or rundown editing permission is no longer active.",
    );
  });
  const guard = [
    access.guard,
    "EXISTS(SELECT 1 FROM member WHERE organizationId=? AND userId=? AND role=?)",
  ];
  const guardArgs = [...access.guardArgs, orgId, actor.userId, member.role];
  if (usesPin) {
    guard.push(
      "COALESCE((SELECT value FROM app_setting WHERE orgId=? AND key=?),'')=?",
    );
    guardArgs.push(orgId, RUNDOWN_PIN_SETTING_KEY, storedPin);
  }
  return { guard: guard.join(" AND "), guardArgs };
}
