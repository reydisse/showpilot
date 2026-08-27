import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(webRoot, "src");

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
}

const runtimeStripeImports = [
  /^\s*import\s+(?!type\b)(?:[^"']+\s+from\s+)?["']stripe["'];?/m,
  /\bimport\(\s*["']stripe["']\s*\)/,
  /\brequire\(\s*["']stripe["']\s*\)/,
];
const violations = walk(sourceRoot)
  .filter((filePath) => /\.[cm]?[jt]sx?$/.test(filePath))
  .filter((filePath) => !filePath.endsWith(".server.ts"))
  .filter((filePath) => {
    const source = readFileSync(filePath, "utf8");
    return runtimeStripeImports.some((pattern) => pattern.test(source));
  })
  .map((filePath) => relative(webRoot, filePath));

if (violations.length > 0) {
  throw new Error(
    `Stripe's server SDK must stay behind a dynamic .server import. Runtime imports found in: ${violations.join(", ")}`,
  );
}

const sensitiveLoggingContracts = [
  {
    path: "src/lib/auth.ts",
    pattern: /console\.log\s*\(/,
    message: "Authentication flows must not log account identifiers, verification URLs, or reset tokens.",
  },
  {
    path: "src/lib/email.ts",
    pattern: /console\.log\s*\(/,
    message: "Email delivery must not log recipients, subjects, or provider response bodies.",
  },
  {
    path: "src/lib/email.ts",
    pattern: /\b(?:res|response)\.text\s*\(/,
    message: "Email delivery must not read raw provider error bodies into application diagnostics.",
  },
];

for (const contract of sensitiveLoggingContracts) {
  const source = readFileSync(resolve(webRoot, contract.path), "utf8");
  if (contract.pattern.test(source)) throw new Error(contract.message);
}

const launchIntegrityContracts = [
  {
    path: "src/lib/data.ts",
    pattern: /\b(?:getCueSheets|addCueSheet|updateCueSheet|deleteCueSheet)\s*=/,
    message: "Legacy standalone cue-sheet CRUD must not return. Cue rows and write access belong to the rundown-backed cue-sheet module.",
  },
  {
    path: "src/lib/data.ts",
    pattern: /\bdeleteChecklistTemplate\s*=/,
    message: "A service checklist must not delete its reusable template and cascade into other shows.",
  },
  {
    path: "src/lib/data.ts",
    pattern: /\b(?:addChecklistTemplate|addChecklistEntry)\s*=/,
    message: "Checklist template and service-entry creation must stay one atomic server-owned command.",
  },
  {
    path: "src/lib/permissions.ts",
    pattern: /\bPLANNED\b/,
    message: "The production permission registry must contain only implemented capabilities.",
  },
  {
    path: "src/lib/data.ts",
    pattern: /\b(?:getNotifications|writeNotification|dismissNotification)\s*=/,
    message: "Legacy organization-wide notification endpoints must not bypass the personal inbox boundary.",
  },
  {
    path: "src/lib/lowerthirds.ts",
    pattern: /\b(?:getLowerThirdState|getLowerThirdStateByOrgId|triggerLowerThird|clearLowerThird|getLowerThirdLibrary)\s*=/,
    message: "Unused lower-third server endpoints must not bypass the graphics and signed Companion control boundaries.",
  },
  {
    path: "src/lib/ontime.ts",
    pattern: /\bgetOntimeConfig\s*=/,
    message: "The configured OnTime URL must stay internal to permission-gated runtime and connection checks.",
  },
];

for (const contract of launchIntegrityContracts) {
  const source = readFileSync(resolve(webRoot, contract.path), "utf8");
  if (contract.pattern.test(source)) throw new Error(contract.message);
}

const requiredLaunchContracts = [
  {
    path: "src/lib/checklist-write.server.ts",
    pattern: /database\.batch\s*\(/,
    message: "Checklist template and first-entry creation must use an atomic native D1 batch.",
  },
  {
    path: "prisma/schema.prisma",
    pattern: /@@unique\(\[orgId,\s*showId,\s*templateId\]\)/,
    message: "The Prisma schema must keep one checklist template entry per show.",
  },
  {
    path: "prisma/migrations/0032_checklist_entry_uniqueness.sql",
    pattern: /CREATE UNIQUE INDEX[\s\S]+checklist_entry[\s\S]+orgId[\s\S]+showId[\s\S]+templateId/,
    message: "Migration 0032 must enforce checklist entry uniqueness in D1.",
  },
  {
    path: "src/routes/__root.tsx",
    pattern: /name:\s*"description"[\s\S]+content:/,
    message: "The application shell must retain a search and sharing description.",
  },
  {
    path: "src/routes/_auth.tsx",
    pattern: /<main[\s\S]+<Outlet\s*\/>[\s\S]+<\/main>/,
    message: "Authentication pages must retain a main landmark.",
  },
  {
    path: "src/routes/_auth\/login.tsx",
    pattern: /aria-label=\{showPassword[\s\S]+className="[^"]*size-10/,
    message: "The password visibility control must retain a 40px touch target.",
  },
];

for (const contract of requiredLaunchContracts) {
  const source = readFileSync(resolve(webRoot, contract.path), "utf8");
  if (!contract.pattern.test(source)) throw new Error(contract.message);
}

function exportedConstBlock(relativePath, exportName) {
  const source = readFileSync(resolve(webRoot, relativePath), "utf8");
  const marker = `export const ${exportName}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing required export ${exportName} in ${relativePath}.`);
  const next = source.indexOf("\nexport const ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

const serverPermissionContracts = [
  ["src/lib/data.ts", "getCrewMembers", /assertOrgPermission\(data\.orgId, "show:view"\)/],
  ["src/lib/data.ts", "addCrewMember", /assertOrgPermission\(data\.orgId, "settings:members"\)/],
  ["src/lib/data.ts", "updateCrewMember", /assertOrgPermission\(data\.orgId, "settings:members"\)/],
  ["src/lib/data.ts", "deleteCrewMember", /assertOrgPermission\(data\.orgId, "settings:members"\)/],
  ["src/lib/data.ts", "getEquipment", /assertOrgPermission\(data\.orgId, "assets:view"\)/],
  ["src/lib/data.ts", "addEquipment", /assertOrgPermission\(data\.orgId, "assets:manage"\)/],
  ["src/lib/data.ts", "updateEquipment", /assertOrgPermission\(data\.orgId, "assets:manage"\)[\s\S]+where:\s*\{\s*id:\s*data\.id,\s*orgId:\s*data\.orgId\s*\}/],
  ["src/lib/data.ts", "deleteEquipment", /assertOrgPermission\(data\.orgId, "assets:manage"\)[\s\S]+where:\s*\{\s*id:\s*data\.id,\s*orgId:\s*data\.orgId\s*\}/],
  ["src/lib/data.ts", "getMicAssignments", /assertOrgPermission\(data\.orgId, "dashboard:tm"\)/],
  ["src/lib/data.ts", "addMicAssignment", /assertOrgPermission\(data\.orgId, "dashboard:tm"\)/],
  ["src/lib/data.ts", "updateMicAssignment", /assertOrgPermission\(data\.orgId, "dashboard:tm"\)[\s\S]+where:\s*\{\s*id:\s*data\.id,\s*orgId:\s*data\.orgId\s*\}/],
  ["src/lib/data.ts", "deleteMicAssignment", /assertOrgPermission\(data\.orgId, "dashboard:tm"\)[\s\S]+where:\s*\{\s*id:\s*data\.id,\s*orgId:\s*data\.orgId\s*\}/],
  ["src/lib/settings.ts", "getOrgSettings", /readMemberVisibleOrgSettings\(getD1\(\), data\.orgId\)/],
  ["src/lib/lowerthirds.ts", "resetLowerThirdLibrary", /assertOrgPermission\(data\.orgId, "lowerthird:configure"\)/],
  ["src/lib/ontime.ts", "getOntimeState", /assertOrgPermission\(data\.orgId, "show:view"\)/],
  ["src/lib/ontime.ts", "testOntimeConnection", /assertOrgPermission\(data\.orgId, "settings:integrations"\)/],
  ["src/lib/chat-proxy.ts", "testChatConnection", /assertOrgPermission\(data\.orgId, "settings:integrations"\)/],
  ["src/lib/chat-proxy.ts", "sendExternalChatMessage", /assertOrgPermission\(data\.orgId, "chat:access"\)/],
  ["src/lib/chat-proxy.ts", "getExternalChatHistory", /assertOrgPermission\(data\.orgId, "chat:access"\)/],
  ["src/lib/chat.ts", "getChatMessages", /assertOrgPermission\(data\.orgId, "chat:access"\)/],
  ["src/lib/chat.ts", "sendChatMessage", /assertOrgPermission\(data\.orgId, "chat:access"\)/],
  ["src/lib/content-reactions.ts", "getContentReactions", /assertAccess\(data\.orgId, data\.targetType\)/],
  ["src/lib/content-reactions.ts", "toggleContentReaction", /assertAccess\(data\.orgId, data\.targetType\)/],
  ["src/lib/report.ts", "exportShowReport", /assertOrgPermission\(data\.orgId, "schedule:view"\)/],
  ["src/lib/rundown.ts", "getRundownState", /assertEffectiveOrgPermission\(data\.orgId, "rundown:view"\)/],
  ["src/lib/rundown.ts", "getRundownOpeningDate", /assertEffectiveOrgPermission\(data\.orgId, "rundown:view"\)/],
  ["src/lib/rundown.ts", "pollProPresenterSlide", /assertEffectiveOrgPermission\(data\.orgId, \["lowerthird:trigger", "rundown:control"\]\)/],
  ["src/lib/rundown.ts", "sendProPresenterCommand", /assertRundownControlAccess\(data\.orgId\)/],
  ["src/lib/rundown.ts", "testProPresenterConnection", /assertEffectiveOrgPermission\(data\.orgId, "settings:integrations"\)/],
];

for (const [relativePath, exportName, pattern] of serverPermissionContracts) {
  if (!pattern.test(exportedConstBlock(relativePath, exportName))) {
    throw new Error(`${exportName} in ${relativePath} is missing its required permission or tenant scope.`);
  }
}

console.log("Client boundary check passed.");
