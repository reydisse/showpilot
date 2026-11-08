import { env } from "cloudflare:workers";
import { getAuth } from "./auth";
import { getPrisma } from "./db";
import { resolveEffectiveAccess } from "./effective-access";
import { getOutputStatusesForOrg } from "./stream-destinations";
import {
  outputVersions,
  runStreamOutputCommand,
} from "./stream-output-command.server";
import { getInputLifecycles } from "./stream-input-lifecycle.server";
import {
  tmStreamCommandSchema,
  tmStreamSnapshotSchema,
  type TmStreamCommand,
} from "./tm-stream-contract";
async function authority(orgId: string, headers: Headers) {
  const session = await getAuth().api.getSession({
    headers,
    query: { disableCookieCache: true },
  });
  if (!session)
    throw new Error("Sign in before controlling streaming outputs.");
  const access = await resolveEffectiveAccess(env.DB, session.user.id, orgId);
  if (
    !access?.permissions.includes("dashboard:tm") ||
    !access.permissions.includes("stream_health:view")
  )
    throw new Error("Forbidden");
  if (
    await env.DB.prepare(
      "SELECT id FROM app_setting WHERE orgId=? AND key='organization-deleting'",
    )
      .bind(orgId)
      .first()
  )
    throw new Error("This workspace is being deleted.");
  return {
    userId: session.user.id,
    userName: session.user.name || "Technical operator",
    canControl: access.permissions.includes("stream_health:manage"),
  };
}
export async function readTmStream(orgId: string, headers: Headers) {
  const actor = await authority(orgId, headers),
    prisma = getPrisma();
  const [destinations, inputs, lifecycles] = await Promise.all([
    prisma.streamDestination.findMany({
      where: { orgId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.liveInput.findMany({
      where: { orgId },
      select: { id: true, name: true, cfInputId: true },
      orderBy: { createdAt: "asc" },
    }),
    getInputLifecycles(orgId),
  ]);
  const [versions, statuses] = await Promise.all([
    outputVersions(orgId, destinations),
    getOutputStatusesForOrg(
      orgId,
      destinations.filter((destination) => destination.cfOutputId !== ""),
    ),
  ]);
  return tmStreamSnapshotSchema.parse({
    canControl: actor.canControl,
    inputs: inputs
      .filter(
        (input) =>
          input.cfInputId &&
          !input.cfInputId.startsWith("pending:") &&
          (!lifecycles[input.id] || lifecycles[input.id] === "ready"),
      )
      .map(({ id, name }) => ({ id, name })),
    destinations: destinations.map((destination) => ({
      id: destination.id,
      name: destination.name,
      enabled: destination.enabled,
      version: versions[destination.id],
      ...(destination.cfOutputId
        ? (statuses[destination.id] ?? {
            status: "unknown",
            error: "Output status was not confirmed.",
          })
        : { status: "none" }),
    })),
  });
}
export async function executeTmStream(
  input: TmStreamCommand,
  headers: Headers,
) {
  const command = tmStreamCommandSchema.parse(input),
    actor = await authority(command.orgId, headers);
  if (!actor.canControl) throw new Error("Forbidden");
  const results = await runStreamOutputCommand({
    ...command,
    actorId: actor.userId,
    action: command.action === "stream-live" ? "live" : "stop",
  });
  if (results.every((result) => result.success)) {
    // Preserve the technical activity notification without duplicating it on
    // lost-response retries. Its timestamp belongs to the original request.
    try {
      const receipt = await env.DB.prepare(
        "SELECT id,createdAt FROM stream_output_command WHERE orgId=? AND actorId=? AND requestId=?",
      )
        .bind(command.orgId, actor.userId, command.requestId)
        .first<{ id: string; createdAt: number }>();
      if (!receipt) throw new Error("Command receipt unavailable");
      const id = `technical-stream:${receipt.id}`;
      await getPrisma().notification.upsert({
        where: { id, orgId: command.orgId },
        update: {},
        create: {
          id,
          orgId: command.orgId,
          type: "technical-control",
          severity: "info",
          title: `Technical control: ${command.action}`,
          message: `${actor.userName} confirmed ${command.action} from the Tech Manager dashboard.`,
          target: "tech-manager",
          source: actor.userId,
          createdAt: new Date(receipt.createdAt),
        },
      });
    } catch {
      return {
        requestId: command.requestId,
        results,
        notificationError:
          "Output changes were confirmed, but the team notification was not saved. Retry to finish the notification without repeating output changes.",
      };
    }
  }
  return { requestId: command.requestId, results };
}
