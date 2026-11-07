import { env } from "cloudflare:workers";
import { z } from "zod";
import { getD1 } from "./d1";
import { CredentialVault } from "./credential-vault.server";
import { markDatabaseWrite } from "./request-database.server";
import {
  streamProviderRequest,
  StreamProviderError,
} from "./stream-provider.server";

type Phase =
  | "prepared"
  | "creating"
  | "identified"
  | "stored"
  | "ready"
  | "deleted";
type Lifecycle = {
  orgId: string;
  inputId: string;
  creationId: string;
  deletionId: string;
  desired: "active" | "deleted";
  phase: Phase;
  providerId: string;
  leaseId: string;
  leaseUntil: number;
};
type Receipt = {
  id: string;
  kind: "create" | "delete";
  inputId: string;
  name: string;
  fingerprint: string;
  completed: number;
};
type Command = { orgId: string; actorId: string; requestId?: string } & (
  | { kind: "create"; name: string }
  | { kind: "delete"; inputId: string }
);
class InputError extends Error {}
const lifecycle = (orgId: string, inputId: string) =>
  getD1()
    .prepare(
      "SELECT orgId,inputId,creationId,deletionId,desired,phase,providerId,leaseId,leaseUntil FROM stream_input_lifecycle WHERE orgId=? AND inputId=?",
    )
    .bind(orgId, inputId)
    .first<Lifecycle>();
const input = (orgId: string, inputId: string) =>
  getD1()
    .prepare(
      "SELECT id,name,cfInputId,rtmpKey FROM live_input WHERE orgId=? AND id=?",
    )
    .bind(orgId, inputId)
    .first<{ id: string; name: string; cfInputId: string; rtmpKey: string }>();
const knownError = (error: unknown) =>
  error instanceof InputError || error instanceof StreamProviderError
    ? error
    : new InputError(
        "The live input operation could not be confirmed. Retry the same request.",
        { cause: error },
      );
async function fingerprint(command: Command, requestId: string) {
  if (!env.BETTER_AUTH_SECRET)
    throw new InputError("Live input retry confirmation is unavailable.");
  const encoder = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.BETTER_AUTH_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      JSON.stringify([
        "stream-input-command-v1",
        command.orgId,
        command.actorId,
        requestId,
        command.kind,
        command.kind === "create" ? command.name : command.inputId,
      ]),
    ),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function admit(command: Command): Promise<Receipt> {
  const db = getD1(),
    requestId = command.requestId ?? crypto.randomUUID(),
    hash = await fingerprint(command, requestId);
  const find = () =>
    db
      .prepare(
        "SELECT id,kind,inputId,name,fingerprint,completed FROM stream_input_command WHERE orgId=? AND actorId=? AND requestId=?",
      )
      .bind(command.orgId, command.actorId, requestId)
      .first<Receipt>();
  const verify = (receipt: Receipt) => {
    if (receipt.fingerprint !== hash)
      throw new InputError(
        "This request ID belongs to different live input changes. Review the saved inputs before submitting another change.",
      );
    return receipt;
  };
  const previous = await find();
  if (previous) return verify(previous);
  const id = crypto.randomUUID(),
    inputId = command.kind === "create" ? crypto.randomUUID() : command.inputId;
  const statements: D1PreparedStatement[] = [];
  let name: string;
  if (command.kind === "create") {
    await CredentialVault.fromSecret(env.CREDENTIAL_ENCRYPTION_KEYS);
    name = command.name;
    statements.push(
      db
        .prepare(
          "INSERT INTO stream_input_command(id,orgId,actorId,requestId,kind,name,inputId,fingerprint,createdAt,precondition) VALUES(?,?,?,?,?,?,?,?,?,1)",
        )
        .bind(
          id,
          command.orgId,
          command.actorId,
          requestId,
          "create",
          name,
          inputId,
          hash,
          Date.now(),
        ),
      db
        .prepare(
          "INSERT INTO live_input(id,orgId,name,cfInputId,status) VALUES(?,?,?,?,'pending')",
        )
        .bind(inputId, command.orgId, name, `pending:${inputId}`),
      db
        .prepare(
          "INSERT INTO stream_input_lifecycle(orgId,inputId,creationId,desired,phase,lastActorId) VALUES(?,?,?,'active','prepared',?)",
        )
        .bind(command.orgId, inputId, id, command.actorId),
    );
  } else {
    const existing = await input(command.orgId, inputId);
    if (!existing) throw new InputError("Live input not found.");
    name = existing.name;
    // Go Live checks this lifecycle in its own atomic admission. Checking both
    // bindings and intents closes the window before a provider output ID exists.
    statements.push(
      db
        .prepare(
          `INSERT INTO stream_input_command(id,orgId,actorId,requestId,kind,name,inputId,fingerprint,createdAt,precondition)
      VALUES(?,?,?,?,?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM live_input WHERE orgId=? AND id=? AND cfInputId=?)
      AND NOT EXISTS(SELECT 1 FROM stream_destination WHERE orgId=? AND liveInputId=? AND cfOutputId<>'')
      AND NOT EXISTS(SELECT 1 FROM stream_output_intent WHERE orgId=? AND ((desiredInputId=? AND action='live') OR (json_extract(state,'$.liveInputId')=? AND json_extract(state,'$.kind')<>'none')))
      THEN 1 ELSE 0 END)`,
        )
        .bind(
          id,
          command.orgId,
          command.actorId,
          requestId,
          "delete",
          name,
          inputId,
          hash,
          Date.now(),
          command.orgId,
          inputId,
          existing.cfInputId,
          command.orgId,
          inputId,
          command.orgId,
          inputId,
          inputId,
        ),
      db
        .prepare(
          `INSERT INTO stream_input_lifecycle(orgId,inputId,deletionId,desired,phase,providerId,lastActorId) VALUES(?,?,?,'deleted','ready',?,?)
        ON CONFLICT(orgId,inputId) DO UPDATE SET deletionId=excluded.deletionId,desired='deleted',lastActorId=excluded.lastActorId`,
        )
        .bind(
          command.orgId,
          inputId,
          id,
          existing.cfInputId.startsWith("pending:") ? "" : existing.cfInputId,
          command.actorId,
        ),
      db
        .prepare(
          "UPDATE live_input SET status='deleting' WHERE orgId=? AND id=?",
        )
        .bind(command.orgId, inputId),
    );
  }
  markDatabaseWrite();
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await find();
    if (raced) return verify(raced);
    if (
      command.kind === "delete" &&
      error instanceof Error &&
      error.message.includes("stream_input_precondition")
    )
      throw new InputError(
        "Stop every destination and pending Go Live request for this input before deleting it. Refresh and retry removal.",
      );
    throw new InputError(
      "The live input change could not be saved. Retry the same request.",
      { cause: error },
    );
  }
  return {
    id,
    kind: command.kind,
    inputId,
    name,
    fingerprint: hash,
    completed: 0,
  };
}

const uidResponse = z.object({
  result: z.object({ uid: z.string().min(1).max(128) }),
});
const inputResponse = z.object({
  result: z.object({
    uid: z.string().min(1).max(128),
    meta: z.unknown(),
    rtmps: z.object({
      url: z
        .string()
        .regex(/^rtmps?:\/\//)
        .max(1000),
      streamKey: z.string().min(1).max(4096),
    }),
    srt: z.object({ url: z.string().max(1000) }).optional(),
  }),
});
async function recoverCreatedInput(inputId: string): Promise<string> {
  const response = await streamProviderRequest(["live_inputs"], "GET");
  const parsed = z
    .object({
      result: z.object({
        liveInputs: z.array(
          z.object({ uid: z.string().min(1).max(128), meta: z.unknown() }),
        ),
      }),
    })
    .safeParse(response);
  if (!parsed.success)
    throw new InputError(
      "The provider returned an unreadable live input list. Retry setup.",
    );
  const matches = parsed.data.result.liveInputs.filter(
    (row) =>
      z.object({ showpilotInputId: z.literal(inputId) }).safeParse(row.meta)
        .success,
  );
  if (matches.length !== 1)
    throw new InputError(
      "The previous input creation is still unconfirmed or ambiguous. Retry setup; no duplicate input was created.",
    );
  return matches[0]!.uid;
}

/** One lease owns physical progress; desired deletion may change underneath it. */
async function reconcile(
  orgId: string,
  inputId: string,
  actorId: string,
): Promise<Phase> {
  const db = getD1(),
    leaseId = crypto.randomUUID();
  markDatabaseWrite();
  const claimed = await db
    .prepare(
      "UPDATE stream_input_lifecycle SET leaseId=?,leaseUntil=?,lastActorId=? WHERE orgId=? AND inputId=? AND (leaseId='' OR leaseUntil<?)",
    )
    .bind(leaseId, Date.now() + 30_000, actorId, orgId, inputId, Date.now())
    .run();
  if (claimed.meta.changes !== 1)
    throw new InputError(
      "This input is still being reconciled by another request. Retry to confirm its result.",
    );
  const current = async () => {
    const row = await lifecycle(orgId, inputId);
    if (!row || row.leaseId !== leaseId || row.leaseUntil <= Date.now())
      throw new InputError(
        "A newer input operation owns this request. Refresh before retrying.",
      );
    return row;
  };
  const persist = async (phase: Phase, providerId: string) => {
    const saved = await db.batch([
      db
        .prepare(
          "UPDATE stream_input_lifecycle SET phase=?,providerId=? WHERE orgId=? AND inputId=? AND leaseId=? AND leaseUntil>?",
        )
        .bind(phase, providerId, orgId, inputId, leaseId, Date.now()),
      db
        .prepare(
          "UPDATE live_input SET cfInputId=?,cfInputUid=? WHERE orgId=? AND id=? AND EXISTS(SELECT 1 FROM stream_input_lifecycle WHERE orgId=? AND inputId=? AND leaseId=? AND phase=? AND providerId=?)",
        )
        .bind(
          providerId || `pending:${inputId}`,
          providerId,
          orgId,
          inputId,
          orgId,
          inputId,
          leaseId,
          phase,
          providerId,
        ),
    ]);
    if (saved[0].meta.changes !== 1)
      throw new InputError(
        "The input operation changed while the provider replied. Retry to reconcile it.",
      );
  };
  try {
    for (let step = 0; step < 6; step++) {
      const state = await current();
      if (state.phase === "deleted") return "deleted";
      if (state.phase === "creating") {
        await persist("identified", await recoverCreatedInput(inputId));
        continue;
      }
      if (state.desired === "deleted") {
        if (state.providerId)
          await streamProviderRequest(
            ["live_inputs", state.providerId],
            "DELETE",
          );
        await current();
        const guard =
          "EXISTS(SELECT 1 FROM stream_input_lifecycle WHERE orgId=? AND inputId=? AND leaseId=? AND desired='deleted' AND deletionId=?)";
        const scope = [orgId, inputId, leaseId, state.deletionId];
        const saved = await db.batch([
          db
            .prepare(
              `DELETE FROM live_input WHERE orgId=? AND id=? AND ${guard}`,
            )
            .bind(orgId, inputId, ...scope),
          db
            .prepare(
              `UPDATE stream_input_command SET completed=1 WHERE orgId=? AND id=? AND ${guard}`,
            )
            .bind(orgId, state.deletionId, ...scope),
          db
            .prepare(
              "UPDATE stream_input_lifecycle SET phase='deleted' WHERE orgId=? AND inputId=? AND leaseId=? AND desired='deleted' AND deletionId=?",
            )
            .bind(...scope),
        ]);
        if (saved[2].meta.changes === 1) return "deleted";
        continue;
      }
      if (state.phase === "ready") return "ready";
      if (state.phase === "prepared") {
        const creation = await db
          .prepare(
            "SELECT name FROM stream_input_command WHERE orgId=? AND id=? AND kind='create'",
          )
          .bind(orgId, state.creationId)
          .first<{ name: string }>();
        if (!creation)
          throw new InputError(
            "The pending setup record is unavailable. Review this input before retrying.",
          );
        await CredentialVault.fromSecret(env.CREDENTIAL_ENCRYPTION_KEYS);
        await persist("creating", "");
        if ((await current()).desired !== "active") {
          await persist("prepared", "");
          continue;
        }
        let response: unknown;
        try {
          response = await streamProviderRequest(["live_inputs"], "POST", {
            enabled: false,
            meta: { name: creation.name, showpilotInputId: inputId },
            recording: { mode: "off" },
          });
        } catch (error) {
          if (
            error instanceof StreamProviderError &&
            error.kind !== "unconfirmed"
          )
            await persist("prepared", "");
          throw error;
        }
        const parsed = uidResponse.safeParse(response);
        if (!parsed.success)
          throw new InputError(
            "The provider did not identify the new input. Retry setup to reconcile it.",
          );
        await persist("identified", parsed.data.result.uid);
        continue;
      }
      if (state.phase === "identified") {
        const parsed = inputResponse.safeParse(
          await streamProviderRequest(["live_inputs", state.providerId], "GET"),
        );
        if (
          !parsed.success ||
          parsed.data.result.uid !== state.providerId ||
          !z
            .object({ showpilotInputId: z.literal(inputId) })
            .safeParse(parsed.data.result.meta).success
        )
          throw new InputError(
            "The provider could not confirm this input's setup credentials. Retry setup.",
          );
        const vault = await CredentialVault.fromSecret(
          env.CREDENTIAL_ENCRYPTION_KEYS,
        );
        const key = await vault.encrypt(
          { kind: "stream-input", orgId, inputId },
          parsed.data.result.rtmps.streamKey,
        );
        const saved = await db.batch([
          db
            .prepare(
              "UPDATE stream_input_lifecycle SET phase='stored' WHERE orgId=? AND inputId=? AND leaseId=? AND phase='identified' AND providerId=? AND leaseUntil>?",
            )
            .bind(orgId, inputId, leaseId, state.providerId, Date.now()),
          db
            .prepare(
              "UPDATE live_input SET rtmpUrl=?,rtmpKey=?,srtUrl=? WHERE orgId=? AND id=? AND EXISTS(SELECT 1 FROM stream_input_lifecycle WHERE orgId=? AND inputId=? AND leaseId=? AND phase='stored' AND providerId=?)",
            )
            .bind(
              parsed.data.result.rtmps.url,
              key,
              parsed.data.result.srt?.url ?? "",
              orgId,
              inputId,
              orgId,
              inputId,
              leaseId,
              state.providerId,
            ),
        ]);
        if (saved[0].meta.changes !== 1 || saved[1].meta.changes !== 1)
          throw new InputError(
            "Input setup changed while its credentials were saved. Retry setup.",
          );
        continue;
      }
      if (state.phase === "stored") {
        if ((await current()).desired !== "active") continue;
        const enabledResponse = await streamProviderRequest(
          ["live_inputs", state.providerId],
          "PUT",
          { enabled: true },
        );
        const confirmed =
          enabledResponse ??
          (await streamProviderRequest(
            ["live_inputs", state.providerId],
            "GET",
          ));
        if (
          !z
            .object({
              result: z.object({
                uid: z.literal(state.providerId),
                enabled: z.literal(true),
              }),
            })
            .safeParse(confirmed).success
        )
          throw new InputError(
            "The provider did not confirm that this input is enabled. Retry setup.",
          );
        await current();
        const guard =
          "EXISTS(SELECT 1 FROM stream_input_lifecycle WHERE orgId=? AND inputId=? AND leaseId=? AND desired='active' AND phase='stored')";
        const scope = [orgId, inputId, leaseId];
        const saved = await db.batch([
          db
            .prepare(
              `UPDATE live_input SET status='unknown' WHERE orgId=? AND id=? AND ${guard}`,
            )
            .bind(orgId, inputId, ...scope),
          db
            .prepare(
              `UPDATE stream_input_command SET completed=1 WHERE orgId=? AND id=? AND ${guard}`,
            )
            .bind(orgId, state.creationId, ...scope),
          db
            .prepare(
              "UPDATE stream_input_lifecycle SET phase='ready' WHERE orgId=? AND inputId=? AND leaseId=? AND desired='active' AND phase='stored'",
            )
            .bind(...scope),
        ]);
        if (saved[2].meta.changes === 1) return "ready";
      }
    }
    throw new InputError(
      "Input setup is still changing. Retry to confirm its current state.",
    );
  } catch (error) {
    throw knownError(error);
  } finally {
    await db
      .prepare(
        "UPDATE stream_input_lifecycle SET leaseId='',leaseUntil=0 WHERE orgId=? AND inputId=? AND leaseId=?",
      )
      .bind(orgId, inputId, leaseId)
      .run();
  }
}

export async function createLiveInputForOrg(command: {
  orgId: string;
  actorId: string;
  name: string;
  requestId?: string;
}): Promise<string> {
  const receipt = await admit({ ...command, kind: "create" });
  if (receipt.completed) {
    if (!(await input(command.orgId, receipt.inputId)))
      throw new InputError(
        "The created input was removed. Retrying will not recreate it.",
      );
    return receipt.inputId;
  }
  if (
    (await reconcile(command.orgId, receipt.inputId, command.actorId)) !==
    "ready"
  )
    throw new InputError(
      "The input was removed while setup was pending. Retrying will not recreate it.",
    );
  return receipt.inputId;
}
export async function resumeLiveInputForOrg(
  orgId: string,
  inputId: string,
  actorId: string,
): Promise<void> {
  const state = await lifecycle(orgId, inputId);
  if (!state || state.desired !== "active")
    throw new InputError(
      "Setup cannot resume while removal is pending. Retry removal instead.",
    );
  if ((await reconcile(orgId, inputId, actorId)) !== "ready")
    throw new InputError("The input was removed while setup was pending.");
}
export async function deleteLiveInputForOrg(command: {
  orgId: string;
  actorId: string;
  inputId: string;
  requestId?: string;
}): Promise<void> {
  const receipt = await admit({ ...command, kind: "delete" });
  if (receipt.completed) return;
  if (
    (await reconcile(command.orgId, receipt.inputId, command.actorId)) !==
    "deleted"
  )
    throw new InputError("Input removal is still unconfirmed. Retry removal.");
}
export async function readLiveInputKey(row: {
  id: string;
  orgId: string;
  rtmpKey: string;
}) {
  if (!row.rtmpKey.startsWith("spenc:")) return row.rtmpKey;
  const vault = await CredentialVault.fromSecret(
    env.CREDENTIAL_ENCRYPTION_KEYS,
  );
  return vault.decrypt(
    { kind: "stream-input", orgId: row.orgId, inputId: row.id },
    row.rtmpKey,
  );
}
export async function getInputLifecycles(orgId: string) {
  const rows = await getD1()
    .prepare(
      "SELECT inputId,desired,phase FROM stream_input_lifecycle WHERE orgId=?",
    )
    .bind(orgId)
    .all<Pick<Lifecycle, "inputId" | "desired" | "phase">>();
  return Object.fromEntries(
    rows.results.map(
      (row) =>
        [
          row.inputId,
          row.desired === "deleted"
            ? "deleting"
            : row.phase === "ready"
              ? "ready"
              : "pending",
        ] as const,
    ),
  );
}
