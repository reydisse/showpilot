import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { idSchema, parseOrThrow } from "./validation";
import { assertOrgPermission } from "./org-access";
import { getD1 } from "./d1";
import { attendanceMember, readAttendanceRows } from "./attendance-state.server";
import { crewAttendanceWriteSchema } from "./crew-attendance-writes";
import { applyCrewAttendance } from "./crew-attendance.server";
export const getCheckInMembers = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => parseOrThrow(z.object({ orgId: idSchema }), data))
  .handler(async ({ data }) => {
    await assertOrgPermission(data.orgId, "checkin:access");
    return Promise.all((await readAttendanceRows(getD1(), data.orgId)).map(attendanceMember));
  });
export const changeCrewAttendance = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => parseOrThrow(crewAttendanceWriteSchema, data))
  .handler(async ({ data }) => {
    const { user } = await assertOrgPermission(data.orgId, "checkin:access");
    return applyCrewAttendance(getD1(), data, user.id);
  });
