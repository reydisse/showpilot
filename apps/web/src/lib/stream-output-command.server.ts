import { env } from "cloudflare:workers";
import { z } from "zod";
import { getD1 } from "./d1";
import { readStreamDestinationKey } from "./stream-destination-write.server";
import { markDatabaseWrite } from "./request-database.server";

export type OutputResult = { id: string; success: boolean; error?: string };
export type OutputCommandOptions = {
  actorId?: string;
  requestId?: string;
  /** A confirmed client snapshot. Omit only for callers without a preview UI. */
  targets?: { id: string; version: string }[];
};
type Action = "live" | "stop" | "disable" | "delete" | "select";
type Command = OutputCommandOptions & {
  orgId: string;
  action: Action;
  liveInputId?: string;
  destinationId?: string;
};
type Destination = {
  id: string;
  orgId: string;
  enabled: number;
  name: string;
  platform: string;
  rtmpUrl: string;
  streamKey: string;
  cfOutputId: string;
  liveInputId: string;
};
const location = { liveInputId: z.string(), cfInputId: z.string().min(1) };
const stateSchema = z.discriminatedUnion("kind", [
  // Imported rows resolve their input inside each target's independent attempt.
  z.object({
    kind: z.literal("unresolved"),
    liveInputId: z.string(),
    outputId: z.string().min(1),
  }),
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("creating"),
    ...location,
    baseline: z.array(z.string()),
    startedAt: z.number(),
  }),
  z.object({ kind: z.literal("legacy"), ...location }),
  z.object({
    kind: z.literal("output"),
    ...location,
    outputId: z.string().min(1),
  }),
]);
type State = z.infer<typeof stateSchema>;
type Intent = {
  commandId: string;
  action: Action;
  desiredInputId: string;
  state: string;
  leaseId: string;
  leaseUntil: number;
};
type Receipt = {
  id: string;
  fingerprint: string;
  targets: string;
  completed: string;
  configurations: string;
};
class OutputError extends Error {}
class ProviderRejected extends OutputError {}
const message = (error: unknown) =>
  error instanceof OutputError
    ? error.message
    : "The output operation could not be confirmed. Retry the same request.";
const superseded = () =>
  new OutputError(
    "A newer output command replaced this request. Refresh to review the current state.",
  );
const readIntent = (orgId: string, id: string) =>
  getD1()
    .prepare(
      "SELECT commandId,action,desiredInputId,state,leaseId,leaseUntil FROM stream_output_intent WHERE orgId=? AND destinationId=?",
    )
    .bind(orgId, id)
    .first<Intent>();
const readDestination = (orgId: string, id: string) =>
  getD1()
    .prepare(
      "SELECT id,orgId,enabled,name,platform,rtmpUrl,streamKey,cfOutputId,liveInputId FROM stream_destination WHERE orgId=? AND id=?",
    )
    .bind(orgId, id)
    .first<Destination>();

async function digest(value: unknown): Promise<string> {
  if (!env.BETTER_AUTH_SECRET)
    throw new OutputError("Output retry confirmation is unavailable.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type Configuration = Pick<
  Destination,
  "id" | "name" | "platform" | "rtmpUrl" | "streamKey"
>;
const configurationFingerprint = (orgId: string, destination: Configuration) =>
  digest([
    "stream-output-config-v1",
    orgId,
    destination.id,
    destination.name,
    destination.platform,
    destination.rtmpUrl,
    destination.streamKey,
  ]);

/** Bound the network AND body read. Never propagate arbitrary provider text or keys. */
async function provider(
  cfInputId: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  outputId = "",
  body?: unknown,
): Promise<unknown> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_STREAM_API_TOKEN)
    throw new OutputError("Streaming provider credentials are not configured.");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/stream/live_inputs/${encodeURIComponent(cfInputId)}/outputs${outputId ? `/${encodeURIComponent(outputId)}` : ""}`,
          {
            method,
            headers: {
              Authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        if (method === "DELETE" && response.status === 404) {
          await response.body?.cancel();
          return null;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if ([400, 401, 403, 404, 422].includes(response.status))
            throw new ProviderRejected(
              "The provider rejected this output request. Review its configuration before retrying.",
            );
          throw new OutputError(
            "The provider did not confirm this output request. Retry to reconcile its result.",
          );
        }
        if (
          response.status === 204 &&
          (method === "DELETE" || method === "PUT")
        )
          return null;
        const value: unknown = await response.json();
        if (
          !z.object({ success: z.literal(true).optional() }).safeParse(value)
            .success
        )
          throw new OutputError(
            "The provider returned an unreadable output result. Retry to reconcile it.",
          );
        return value;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new OutputError(
              "The provider did not confirm within five seconds. Retry the same request.",
            ),
          );
        }, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
const outputsSchema = z.object({
  result: z.array(
    z.object({
      uid: z.string().min(1),
      url: z.string(),
      streamKey: z.string(),
      enabled: z.boolean().optional(),
    }),
  ),
});
async function listOutputs(cfInputId: string) {
  const parsed = outputsSchema.safeParse(await provider(cfInputId, "GET"));
  if (!parsed.success)
    throw new OutputError(
      "The provider returned an unreadable output list. Retry to check again.",
    );
  return parsed.data.result;
}
async function inputLocation(orgId: string, id: string) {
  const input = await getD1()
    .prepare("SELECT cfInputId FROM live_input WHERE orgId=? AND id=?")
    .bind(orgId, id)
    .first<{ cfInputId: string }>();
  if (!input?.cfInputId)
    throw new OutputError("The connected live input could not be found.");
  return { liveInputId: id, cfInputId: input.cfInputId };
}
function initialState(destination: Destination): State {
  return destination.cfOutputId
    ? {
        kind: "unresolved",
        liveInputId: destination.liveInputId,
        outputId: destination.cfOutputId,
      }
    : { kind: "none" };
}

async function prepare(command: Command): Promise<Receipt> {
  const db = getD1(),
    actorId = command.actorId ?? "internal",
    requestId = command.requestId ?? crypto.randomUUID();
  const fingerprint = await digest([
    "stream-output-command-v1",
    command.orgId,
    actorId,
    requestId,
    command.action,
    command.liveInputId ?? null,
    command.destinationId ?? null,
    command.targets ?? null,
  ]);
  const find = () =>
    db
      .prepare(
        "SELECT id,fingerprint,targets,completed,configurations FROM stream_output_command WHERE orgId=? AND actorId=? AND requestId=?",
      )
      .bind(command.orgId, actorId, requestId)
      .first<Receipt>();
  const validate = (receipt: Receipt) => {
    if (receipt.fingerprint !== fingerprint)
      throw new OutputError(
        "This request ID belongs to different output changes. Refresh before issuing a new command.",
      );
    return receipt;
  };
  const previous = await find();
  if (previous) return validate(previous);
  let ids: string[];
  if (command.destinationId) ids = [command.destinationId];
  else if (command.targets) ids = command.targets.map((target) => target.id);
  else {
    const rows = await db
      .prepare(
        `SELECT id FROM stream_destination WHERE orgId=? AND ${command.action === "live" ? "enabled=1" : "(enabled=1 OR cfOutputId<>'')"} ORDER BY createdAt,id`,
      )
      .bind(command.orgId)
      .all<{ id: string }>();
    ids = rows.results.map((row) => row.id);
  }
  if (new Set(ids).size !== ids.length)
    throw new OutputError(
      "The output request contains duplicate destinations.",
    );
  const configurations: Record<string, string> = {};
  const id = crypto.randomUUID(),
    statements: D1PreparedStatement[] = [],
    now = Date.now();
  for (const destinationId of ids) {
    if (command.action === "stop") {
      // Fence every existing target atomically, preserving newer physical state.
      // Missing/damaged targets report independently instead of blocking Stop All.
      statements.push(
        db
          .prepare(
            `INSERT INTO stream_output_intent(orgId,destinationId,commandId,action,desiredInputId,state)
        SELECT orgId,id,?,'stop','',CASE WHEN cfOutputId='' THEN '{"kind":"none"}' ELSE json_object('kind','unresolved','liveInputId',liveInputId,'outputId',cfOutputId) END
        FROM stream_destination WHERE orgId=? AND id=?
        ON CONFLICT(orgId,destinationId) DO UPDATE SET commandId=excluded.commandId,action='stop',desiredInputId=''`,
          )
          .bind(id, command.orgId, destinationId),
      );
      continue;
    }
    const destination = await readDestination(command.orgId, destinationId);
    if (!destination) throw new OutputError("Destination not found.");
    const intent = await readIntent(command.orgId, destinationId);
    const configuration = await configurationFingerprint(
      command.orgId,
      destination,
    );
    if (command.action === "live")
      configurations[destinationId] = configuration;
    const expected = command.targets?.find(
      (target) => target.id === destinationId,
    )?.version;
    if (
      (command.action === "live" || command.action === "select") &&
      expected !== undefined &&
      expected !== `${intent?.commandId ?? ""}:${configuration}`
    )
      throw superseded();
    // Go Live cannot overtake an unresolved Stop or a provider call. Stop may
    // supersede Go Live but must preserve its state until the lease is released.
    if (
      (command.action === "live" || command.action === "select") &&
      intent &&
      (intent.leaseUntil > now ||
        (intent.action !== "live" &&
          intent.action !== "select" &&
          stateSchema.parse(JSON.parse(intent.state)).kind !== "none"))
    ) {
      throw new OutputError(
        "A previous output command is still unconfirmed. Retry that command before starting another.",
      );
    }
    if (command.action === "live" && !destination.enabled)
      throw new OutputError(
        "This destination is no longer selected. Review destinations before going live.",
      );
    const state = intent?.state ?? JSON.stringify(initialState(destination));
    // The receipt's CHECK makes this a single atomic comparison-and-write.
    const guard = db
      .prepare(
        `INSERT INTO stream_output_command(id,orgId,actorId,requestId,fingerprint,targets,createdAt,precondition)
      SELECT ?,?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM stream_destination WHERE orgId=? AND id=? AND cfOutputId=? AND liveInputId=? AND enabled=?)
      AND COALESCE((SELECT commandId FROM stream_output_intent WHERE orgId=? AND destinationId=?),'')=? THEN 1 ELSE 0 END`,
      )
      .bind(
        `${id}:guard:${destinationId}`,
        command.orgId,
        actorId,
        `${requestId}:guard:${destinationId}`,
        fingerprint,
        "[]",
        now,
        command.orgId,
        destinationId,
        destination.cfOutputId,
        destination.liveInputId,
        destination.enabled,
        command.orgId,
        destinationId,
        intent?.commandId ?? "",
      );
    statements.push(
      guard,
      db
        .prepare(
          `INSERT INTO stream_output_intent(orgId,destinationId,commandId,action,desiredInputId,state) VALUES(?,?,?,?,?,?)
      ON CONFLICT(orgId,destinationId) DO UPDATE SET commandId=excluded.commandId,action=excluded.action,desiredInputId=excluded.desiredInputId`,
        )
        .bind(
          command.orgId,
          destinationId,
          id,
          command.action,
          command.liveInputId ?? "",
          state,
        ),
      db
        .prepare("DELETE FROM stream_output_command WHERE orgId=? AND id=?")
        .bind(command.orgId, `${id}:guard:${destinationId}`),
    );
  }
  statements.unshift(
    db
      .prepare(
        "INSERT INTO stream_output_command(id,orgId,actorId,requestId,fingerprint,targets,configurations,createdAt,precondition) VALUES(?,?,?,?,?,?,?,?,1)",
      )
      .bind(
        id,
        command.orgId,
        actorId,
        requestId,
        fingerprint,
        JSON.stringify(ids),
        JSON.stringify(configurations),
        now,
      ),
  );
  markDatabaseWrite();
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await find();
    if (raced) return validate(raced);
    throw new OutputError(
      "The destinations changed while this command was being prepared. Refresh before retrying.",
      { cause: error },
    );
  }
  return {
    id,
    fingerprint,
    targets: JSON.stringify(ids),
    completed: "{}",
    configurations: JSON.stringify(configurations),
  };
}

async function executeTarget(
  command: Command,
  receipt: Receipt,
  destinationId: string,
): Promise<OutputResult> {
  const db = getD1(),
    orgId = command.orgId,
    leaseId = crypto.randomUUID();
  const scope = [orgId, destinationId, leaseId] as const;
  const owner = await readIntent(orgId, destinationId);
  if (!owner)
    return {
      id: destinationId,
      success: false,
      error: "Destination not found.",
    };
  if (owner.commandId !== receipt.id)
    return { id: destinationId, success: false, error: superseded().message };
  const claim = await db
    .prepare(
      "UPDATE stream_output_intent SET leaseId=?,leaseUntil=? WHERE orgId=? AND destinationId=? AND commandId=? AND (leaseId='' OR leaseUntil<?)",
    )
    .bind(
      leaseId,
      Date.now() + 30_000,
      orgId,
      destinationId,
      receipt.id,
      Date.now(),
    )
    .run();
  if (claim.meta.changes !== 1)
    return {
      id: destinationId,
      success: false,
      error:
        "Another output operation is still being reconciled. Retry this request.",
    };
  const current = async () => {
    const row = await readIntent(orgId, destinationId);
    if (
      !row ||
      row.commandId !== receipt.id ||
      row.leaseId !== leaseId ||
      row.leaseUntil <= Date.now()
    )
      throw superseded();
    return row;
  };
  const saveState = async (
    state: State,
    credentialClaim?: string,
    snapshot?: Destination,
  ) => {
    const marker =
      state.kind === "none"
        ? ""
        : state.kind === "output" || state.kind === "unresolved"
          ? state.outputId
          : `pending:${state.kind === "creating" ? state.startedAt : Date.now()}:${receipt.id}`;
    const check = snapshot
      ? " AND EXISTS(SELECT 1 FROM stream_destination WHERE orgId=? AND id=? AND rtmpUrl=? AND streamKey=? AND enabled=1)"
      : "";
    const values = snapshot
      ? [orgId, destinationId, snapshot.rtmpUrl, snapshot.streamKey]
      : [];
    const result = await db.batch([
      db
        .prepare(
          `UPDATE stream_output_intent SET state=?,credentialClaim=CASE WHEN ? THEN NULL ELSE COALESCE(?,credentialClaim) END WHERE orgId=? AND destinationId=? AND leaseId=? AND leaseUntil>?${check}`,
        )
        .bind(
          JSON.stringify(state),
          state.kind === "none" ? 1 : 0,
          credentialClaim ?? null,
          ...scope,
          Date.now(),
          ...values,
        ),
      db
        .prepare(
          "UPDATE stream_destination SET cfOutputId=?,liveInputId=? WHERE orgId=? AND id=? AND EXISTS(SELECT 1 FROM stream_output_intent WHERE orgId=? AND destinationId=? AND leaseId=? AND state=?)",
        )
        .bind(
          marker,
          state.kind === "none" ? "" : state.liveInputId,
          orgId,
          destinationId,
          ...scope,
          JSON.stringify(state),
        ),
    ]);
    if (result[0].meta.changes !== 1)
      throw new OutputError(
        "This destination changed while Go Live was starting. Refresh before retrying.",
      );
  };
  try {
    let intent = await current(),
      state = stateSchema.parse(JSON.parse(intent.state));
    const destination = await readDestination(orgId, destinationId);
    if (!destination) throw new OutputError("Destination not found.");
    if (command.action === "live") {
      const configurations = z
        .record(z.string(), z.string())
        .parse(JSON.parse(receipt.configurations));
      if (
        configurations[destinationId] !==
        (await configurationFingerprint(orgId, destination))
      )
        throw new OutputError(
          "Destination settings changed since Go Live was confirmed. Review them before starting a new command.",
        );
    }
    if (state.kind === "unresolved") {
      const bound = await inputLocation(orgId, state.liveInputId);
      state = state.outputId.startsWith("pending:")
        ? { kind: "legacy", ...bound }
        : { kind: "output", ...bound, outputId: state.outputId };
      await saveState(state);
    }
    if (command.action === "select") {
      if (state.kind === "creating" || state.kind === "legacy")
        throw new OutputError(
          "Resolve this pending output before changing its selection.",
        );
    } else {
      if (state.kind === "creating" || state.kind === "legacy") {
        const streamKey = await readStreamDestinationKey(destination);
        const pending = state;
        if (pending.kind === "legacy") {
          const peer = await db
            .prepare(
              "SELECT 1 FROM stream_destination d JOIN live_input i ON i.id=d.liveInputId AND i.orgId=d.orgId WHERE d.orgId=? AND d.id<>? AND i.cfInputId=? AND d.rtmpUrl=? AND d.cfOutputId LIKE 'pending:%' LIMIT 1",
            )
            .bind(orgId, destinationId, pending.cfInputId, destination.rtmpUrl)
            .first();
          if (peer)
            throw new OutputError(
              "More than one legacy creation may own this output. Review the provider before retrying; no output was changed.",
            );
        }
        const candidates = (await listOutputs(pending.cfInputId)).filter(
          (output) =>
            output.url === destination.rtmpUrl &&
            output.streamKey === streamKey &&
            (pending.kind === "legacy" ||
              !pending.baseline.includes(output.uid)),
        );
        const ownership = await db
          .prepare(
            "SELECT destinationId,state FROM stream_output_intent WHERE orgId=? AND destinationId<>?",
          )
          .bind(orgId, destinationId)
          .all<{ destinationId: string; state: string }>();
        const rows = await db
          .prepare(
            "SELECT d.cfOutputId FROM stream_destination d JOIN live_input i ON i.id=d.liveInputId AND i.orgId=d.orgId WHERE d.orgId=? AND d.id<>? AND i.cfInputId=?",
          )
          .bind(orgId, destinationId, pending.cfInputId)
          .all<{ cfOutputId: string }>();
        const claimed = new Set(rows.results.map((row) => row.cfOutputId));
        for (const row of ownership.results) {
          const other = stateSchema.parse(JSON.parse(row.state));
          if (other.kind === "output" && other.cfInputId === pending.cfInputId)
            claimed.add(other.outputId);
        }
        if (candidates.length !== 1 || claimed.has(candidates[0]!.uid))
          throw new OutputError(
            "The previous creation is still unconfirmed or ambiguous. Retry to reconcile it; no duplicate output was created.",
          );
        state = {
          kind: "output",
          liveInputId: pending.liveInputId,
          cfInputId: pending.cfInputId,
          outputId: candidates[0]!.uid,
        };
        await saveState(state);
      }
      intent = await current();
      if (command.action === "live") {
        if (
          state.kind !== "none" &&
          state.liveInputId !== intent.desiredInputId
        )
          throw new OutputError(
            "Stop this destination before switching its live input.",
          );
        if (state.kind === "none") {
          const bound = await inputLocation(orgId, intent.desiredInputId);
          const streamKey = await readStreamDestinationKey(destination);
          // Verify the credential snapshot before any external request.
          const actual = await readDestination(orgId, destinationId);
          if (
            !actual ||
            !actual.enabled ||
            actual.rtmpUrl !== destination.rtmpUrl ||
            actual.streamKey !== destination.streamKey
          )
            throw new OutputError(
              "This destination changed while Go Live was starting. Refresh before retrying.",
            );
          const credentialClaim = await digest([
            "stream-output-credentials-v1",
            orgId,
            bound.cfInputId,
            destination.rtmpUrl,
            streamKey,
          ]);
          const legacy = await db
            .prepare(
              "SELECT 1 FROM stream_destination d JOIN live_input i ON i.id=d.liveInputId AND i.orgId=d.orgId LEFT JOIN stream_output_intent s ON s.orgId=d.orgId AND s.destinationId=d.id WHERE d.orgId=? AND d.id<>? AND i.cfInputId=? AND d.rtmpUrl=? AND d.cfOutputId LIKE 'pending:%' AND (s.state IS NULL OR json_extract(s.state,'$.kind') IN ('legacy','unresolved')) LIMIT 1",
            )
            .bind(orgId, destinationId, bound.cfInputId, destination.rtmpUrl)
            .first();
          if (legacy)
            throw new OutputError(
              "Resolve the previous legacy creation before starting another destination on this RTMP endpoint.",
            );
          const baseline = (await listOutputs(bound.cfInputId)).map(
            (output) => output.uid,
          );
          await current();
          state = {
            kind: "creating",
            ...bound,
            baseline,
            startedAt: Date.now(),
          };
          try {
            await saveState(state, credentialClaim, destination);
          } catch (error) {
            if (error instanceof OutputError) throw error;
            throw new OutputError(
              "Another destination owns these output credentials. Stop it before going live here.",
            );
          }
          try {
            await current();
          } catch (error) {
            await saveState({ kind: "none" });
            throw error;
          }
          let response: unknown;
          try {
            response = await provider(bound.cfInputId, "POST", "", {
              url: destination.rtmpUrl,
              streamKey,
              enabled: false,
            });
          } catch (error) {
            if (error instanceof ProviderRejected)
              await saveState({ kind: "none" });
            throw error;
          }
          const parsed = z
            .object({ result: z.object({ uid: z.string().min(1) }) })
            .safeParse(response);
          if (!parsed.success)
            throw new OutputError(
              "The provider did not identify the new output. Retry to reconcile it.",
            );
          state = {
            kind: "output",
            ...bound,
            outputId: parsed.data.result.uid,
          };
          await saveState(state);
        }
        if (state.kind !== "output")
          throw new OutputError(
            "The output creation is still unconfirmed. Retry this request.",
          );
        await current();
        await provider(state.cfInputId, "PUT", state.outputId, {
          enabled: true,
        });
      } else if (state.kind === "output") {
        await current();
        await provider(state.cfInputId, "DELETE", state.outputId);
        state = { kind: "none" };
        await saveState(state);
      }
    }
    await current();
    // Completion and local metadata commit together. A stale handler cannot
    // finish a command after a newer Stop has taken ownership.
    const guard =
      "EXISTS(SELECT 1 FROM stream_output_intent WHERE orgId=? AND destinationId=? AND commandId=? AND leaseId=?)";
    const args = [orgId, destinationId, receipt.id, leaseId];
    const changes: D1PreparedStatement[] = [];
    if (command.action === "delete")
      changes.push(
        db
          .prepare(
            `DELETE FROM stream_destination WHERE orgId=? AND id=? AND ${guard}`,
          )
          .bind(orgId, destinationId, ...args),
      );
    if (command.action === "disable" || command.action === "select")
      changes.push(
        db
          .prepare(
            `UPDATE stream_destination SET enabled=? WHERE orgId=? AND id=? AND ${guard}`,
          )
          .bind(
            command.action === "select" ? 1 : 0,
            orgId,
            destinationId,
            ...args,
          ),
      );
    changes.push(
      db
        .prepare(
          `UPDATE stream_output_command SET completed=json_patch(completed,json_object(?,1)) WHERE orgId=? AND id=? AND ${guard}`,
        )
        .bind(destinationId, orgId, receipt.id, ...args),
    );
    const saved = await db.batch(changes);
    if (saved[saved.length - 1]?.meta.changes !== 1) throw superseded();
    return { id: destinationId, success: true };
  } catch (error) {
    return { id: destinationId, success: false, error: message(error) };
  } finally {
    await db
      .prepare(
        "UPDATE stream_output_intent SET leaseId='',leaseUntil=0 WHERE orgId=? AND destinationId=? AND leaseId=?",
      )
      .bind(...scope)
      .run();
  }
}

/** The caller checks current permission before EVERY attempt, including receipt replay. */
export async function runStreamOutputCommand(
  command: Command,
): Promise<OutputResult[]> {
  const receipt = await prepare(command);
  markDatabaseWrite();
  const targets = z.array(z.string()).parse(JSON.parse(receipt.targets));
  const completed = z
    .record(z.string(), z.literal(1))
    .parse(JSON.parse(receipt.completed));
  const results: OutputResult[] = [];
  // Bound concurrency while keeping an independent destination from waiting on
  // every failed provider call in the organization.
  for (let offset = 0; offset < targets.length; offset += 4) {
    results.push(
      ...(await Promise.all(
        targets
          .slice(offset, offset + 4)
          .map(async (id): Promise<OutputResult> => {
            if (completed[id] === 1) return { id, success: true };
            try {
              return await executeTarget(command, receipt, id);
            } catch (error) {
              return { id, success: false, error: message(error) };
            }
          }),
      )),
    );
  }
  return results;
}

/** Bind the confirmation to both output intent and the exact displayed configuration. */
export async function outputVersions(
  orgId: string,
  snapshot?: readonly Configuration[],
): Promise<Record<string, string>> {
  const intents = await getD1()
    .prepare(
      "SELECT destinationId,commandId FROM stream_output_intent WHERE orgId=?",
    )
    .bind(orgId)
    .all<{ destinationId: string; commandId: string }>();
  const versions = new Map(
    intents.results.map((row) => [row.destinationId, row.commandId]),
  );
  const destinations =
    snapshot ??
    (
      await getD1()
        .prepare(
          "SELECT id,name,platform,rtmpUrl,streamKey FROM stream_destination WHERE orgId=?",
        )
        .bind(orgId)
        .all<Configuration>()
    ).results;
  return Object.fromEntries(
    await Promise.all(
      destinations.map(async (destination) => [
        destination.id,
        `${versions.get(destination.id) ?? ""}:${await configurationFingerprint(orgId, destination)}`,
      ]),
    ),
  );
}
