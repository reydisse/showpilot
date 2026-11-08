import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { parseOrThrow } from "./validation";
import { copyTeamCommandSchema } from "./schedule-copy-contract";
import { runCopyScheduleTeam } from "./schedule-copy.server";
export const copyScheduleTeam = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    parseOrThrow(copyTeamCommandSchema, input),
  )
  .handler(({ data }) => runCopyScheduleTeam(getRequestHeaders(), data));
