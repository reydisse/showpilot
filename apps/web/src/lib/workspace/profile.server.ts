import { z } from "zod";
import {
  WORKSPACE_TYPES,
  WORKSPACE_SETTING_KEYS,
  MODULE_IDS,
  DEFAULT_WORKSPACE_MODULES,
  WORKSPACE_DEFINITIONS,
  resolveWorkspaceProfile,
  resolveModules,
  legacyTerminologyProfile,
  legacyWorkspaceType,
  isWorkspaceTerm,
  type WorkspaceSettings,
  type WorkspaceProfile,
} from "@showpilot/shared";
import type { MobileApiDatabase } from "../mobile-api.server";

const term = z
  .string()
  .trim()
  .refine(isWorkspaceTerm, "Use 1–24 plain-text characters");
export const workspaceCustomSchema = z
  .object({
    label: z
      .string()
      .trim()
      .max(80)
      .refine((value) => !/[<>\x00-\x1f\x7f]/.test(value), "Use plain text"),
    terms: z
      .object({
        event: term.optional(),
        events: term.optional(),
        item: term.optional(),
        items: term.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const workspaceTypeSchema = z.enum(WORKSPACE_TYPES);
export const workspaceModulesSchema = z.array(z.enum(MODULE_IDS));
export const workspaceCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initial"),
    type: workspaceTypeSchema,
    custom: workspaceCustomSchema.optional(),
    modules: workspaceModulesSchema.optional(),
    onlyIfUnconfigured: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("type"),
    type: workspaceTypeSchema,
    resetModules: z.boolean(),
  }),
  z.object({ kind: z.literal("modules"), modules: workspaceModulesSchema }),
  z.object({ kind: z.literal("custom"), custom: workspaceCustomSchema }),
  z.object({
    kind: z.literal("legacy"),
    terminologyProfile: z.enum(["general", "church"]).optional(),
  }),
]);
export type WorkspaceCommand = z.infer<typeof workspaceCommandSchema>;
export interface WorkspaceStore {
  read(): Promise<WorkspaceSettings>;
  write(
    entries: [string, string][],
    onlyIfUnconfigured?: boolean,
  ): Promise<void>;
}
export function workspaceD1Store(
  db: MobileApiDatabase,
  orgId: string,
): WorkspaceStore {
  return {
    async read() {
      const rows = await db
        .prepare(
          "SELECT key, value FROM app_setting WHERE orgId = ? AND key IN ('workspace-type', 'workspace-modules', 'workspace-custom', 'terminology-profile')",
        )
        .bind(orgId)
        .all<{ key: string; value: string }>();
      return Object.fromEntries(
        (rows.results ?? []).map((row) => [row.key, row.value]),
      );
    },
    async write(entries, onlyIfUnconfigured = false) {
      // Put the explicit type last so an initial batch tests the same condition
      // for every row. D1 batches execute atomically, including concurrent calls.
      const ordered = [...entries].sort(
        ([a], [b]) =>
          Number(a === "workspace-type") - Number(b === "workspace-type"),
      );
      const statements = ordered.map(([key, value]) =>
        onlyIfUnconfigured
          ? db
              .prepare(
                `INSERT INTO app_setting (id, orgId, key, value) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_setting WHERE orgId = ? AND key = 'workspace-type') ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value`,
              )
              .bind(crypto.randomUUID(), orgId, key, value, orgId)
          : db
              .prepare(
                "INSERT INTO app_setting (id, orgId, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(orgId, key) DO UPDATE SET value = excluded.value",
              )
              .bind(crypto.randomUUID(), orgId, key, value),
      );
      const results = await db.batch(statements);
      if (
        onlyIfUnconfigured &&
        results.every((result) => result.meta?.changes === 0)
      )
        throw new Error("Workspace type is already configured");
    },
  };
}
export async function workspacePrismaStore(
  orgId: string,
): Promise<WorkspaceStore> {
  const { getPrisma } = await import("../db");
  const prisma = getPrisma();
  return {
    async read() {
      const rows = await prisma.appSetting.findMany({
        where: { orgId, key: { in: [...WORKSPACE_SETTING_KEYS] } },
        select: { key: true, value: true },
      });
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
    async write(entries) {
      await prisma.$transaction(
        entries.map(([key, value]) =>
          prisma.appSetting.upsert({
            where: { orgId_key: { orgId, key } },
            update: { value },
            create: { orgId, key, value },
          }),
        ),
      );
    },
  };
}
export async function readWorkspaceProfile(
  store: WorkspaceStore,
): Promise<WorkspaceProfile> {
  return resolveWorkspaceProfile(await store.read());
}
export async function getWorkspaceProfileForOrg(orgId: string) {
  return readWorkspaceProfile(await workspacePrismaStore(orgId));
}
export async function writeWorkspaceProfile(
  store: WorkspaceStore,
  command: WorkspaceCommand,
): Promise<WorkspaceProfile> {
  const settings = await store.read();
  const current = resolveWorkspaceProfile(settings);
  const entries: [string, string][] = [];
  switch (command.kind) {
    case "initial":
      if (command.onlyIfUnconfigured && current.isExplicit)
        throw new Error("Workspace type is already configured");
      entries.push(
        ["workspace-type", command.type],
        ["terminology-profile", legacyTerminologyProfile(command.type)],
        [
          "workspace-modules",
          JSON.stringify(
            resolveModules(
              WORKSPACE_DEFINITIONS[command.type].customizable
                ? (command.modules ?? DEFAULT_WORKSPACE_MODULES[command.type])
                : DEFAULT_WORKSPACE_MODULES[command.type],
            ),
          ),
        ],
      );
      if (WORKSPACE_DEFINITIONS[command.type].customizable)
        entries.push([
          "workspace-custom",
          JSON.stringify(command.custom ?? { label: "", terms: {} }),
        ]);
      break;
    case "type":
      entries.push(
        ["workspace-type", command.type],
        ["terminology-profile", legacyTerminologyProfile(command.type)],
      );
      if (command.resetModules)
        entries.push([
          "workspace-modules",
          JSON.stringify(DEFAULT_WORKSPACE_MODULES[command.type]),
        ]);
      break;
    case "modules":
      entries.push([
        "workspace-modules",
        JSON.stringify(resolveModules(command.modules)),
      ]);
      break;
    case "custom":
      if (!WORKSPACE_DEFINITIONS[current.type].customizable)
        throw new Error("Choose a custom workspace before editing names");
      entries.push(["workspace-custom", JSON.stringify(command.custom)]);
      break;
    case "legacy":
      if (command.terminologyProfile) {
        const type = legacyWorkspaceType(
          current.type,
          command.terminologyProfile,
        );
        entries.push(
          ["workspace-type", type],
          ["terminology-profile", legacyTerminologyProfile(type)],
        );
      }
      break;
  }
  if (entries.length)
    await store.write(
      entries,
      command.kind === "initial" && command.onlyIfUnconfigured,
    );
  return entries.length ? readWorkspaceProfile(store) : current;
}
