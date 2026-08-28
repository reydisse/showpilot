import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { findAnonymousJsxControls } from "../../../scripts/jsx-control-names.mjs";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
const appConfig = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8"));
const packageConfig = JSON.parse(readFileSync(resolve(mobileRoot, "package.json"), "utf8"));
const easConfig = JSON.parse(readFileSync(resolve(mobileRoot, "eas.json"), "utf8"));
const storeConfig = JSON.parse(readFileSync(resolve(mobileRoot, "store.config.json"), "utf8"));
const parityConfig = JSON.parse(readFileSync(resolve(mobileRoot, "parity.config.json"), "utf8"));
const requireReleaseLink = process.argv.slice(2).includes("--release");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--release");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown mobile verification argument: ${unknownArguments[0]}`);
}
const runtimeVersions = {
  expo: "54.0.37",
  "expo-dev-client": "6.0.21",
  "expo-updates": "29.0.20",
  "react-native": "0.81.5",
};
const maximumNativeBundleBytes = 6_500_000;
const featureContract = [
  ["src/app/(app)/shows.tsx", "/api/mobile/v1/bootstrap"],
  ["src/app/(app)/shows.tsx", "/api/mobile/v1/rundowns"],
  ["src/app/schedule.tsx", "/api/mobile/v1/schedule"],
  ["src/app/incidents.tsx", "/api/mobile/v1/incidents"],
  ["src/app/incidents-history.tsx", "/api/mobile/v1/incidents/history"],
  ["src/app/checklist.tsx", "/api/mobile/v1/checklist"],
  ["src/app/checkin.tsx", "/api/mobile/v1/checkin"],
  ["src/app/show-board.tsx", "/api/mobile/v1/show-board"],
  ["src/app/live-show.tsx", "/api/mobile/v1/show-workspace"],
  ["src/app/team-members.tsx", "/api/mobile/v1/team/members"],
  ["src/app/team-crew.tsx", "/api/mobile/v1/team/crew"],
  ["src/app/team.tsx", "/api/mobile/v1/team/access"],
  ["src/app/devices.tsx", "/api/mobile/v1/devices"],
  ["src/app/device/[deviceId].tsx", "const deviceControlMatch"],
  ["src/app/timecode.tsx", "const tcMatch"],
  ["src/app/cue-sheets.tsx", "/api/mobile/v1/cue-sheets"],
  ["src/app/asset-inventory.tsx", "/api/mobile/v1/assets"],
  ["src/app/stream.tsx", "/api/mobile/v1/streaming"],
  ["src/app/multi-platform.tsx", "/api/mobile/v1/streaming/destinations"],
  ["src/app/lower-thirds.tsx", "/api/mobile/v1/graphics"],
  ["src/app/prod-manager.tsx", "const mobileDashboardMatch"],
  ["src/app/reports.tsx", "/api/mobile/v1/reports"],
  ["src/app/tech-manager.tsx", "const mobileDashboardMatch"],
  ["src/app/audio.tsx", "/api/mobile/v1/audio"],
  ["src/app/(app)/profile.tsx", "/api/user/avatar"],
];
const sourceContract = [
  ["src/app/(app)/shows.tsx", "createMobileRundown"],
  ["src/app/incidents.tsx", "getServiceDateForTimeZone"],
  ["src/app/incidents.tsx", "commandMobileIncident"],
  ["src/app/incidents.tsx", "targetUserId"],
  ["src/app/incidents.tsx", "updateMobileIncident"],
  ["src/app/incidents.tsx", "removeMobileIncident"],
  ["src/app/incidents.tsx", "addMobileIncidentComment"],
  ["src/app/incidents.tsx", "setMobileIncidentCommentReaction"],
  ["src/app/incidents-history.tsx", "getMobileIncidentHistory"],
  ["src/app/incidents-history.tsx", "<FlatList"],
  ["src/app/settings.tsx", "setAppThemePreference"],
  ["src/app/settings.tsx", "getNativeNotificationPermissionState"],
  ["src/app/(app)/profile.tsx", 'router.push("/settings")'],
  ["src/app/(app)/inbox.tsx", "<FlatList"],
  ["src/app/(app)/shows.tsx", "<FlatList"],
  ["src/app/show/[showId].tsx", "function TimerPanel"],
  ["src/app/show/[showId].tsx", "<FlatList"],
  ["src/app/schedule.tsx", "<FlatList"],
  ["src/app/incidents.tsx", "<FlatList"],
  ["src/app/checklist.tsx", "getMobileChecklistDraft"],
  ["src/app/checklist.tsx", "toggleMobileChecklistEntry"],
  ["src/app/checklist.tsx", "<FlatList"],
  ["src/app/checkin.tsx", "setMobileCheckInStatus"],
  ["src/app/checkin.tsx", "<FlatList"],
  ["src/app/show-board.tsx", "refetchInterval: 3_000"],
  ["src/app/show-board.tsx", "<SvgUri"],
  ["src/app/live-show.tsx", "useRundownRelay"],
  ["src/app/live-show.tsx", 'runtime.kind === "ontime"'],
  ["src/app/live-show.tsx", "<FlatList"],
  ["src/app/(app)/operations.tsx", 'permissions.has("show:view")'],
  ["src/app/(app)/operations.tsx", 'permissions.has("showboard:view")'],
  ["src/app/_layout.tsx", 'name="live-show"'],
  ["src/app/_layout.tsx", 'name="show-board"'],
  ["src/app/team-members.tsx", "inviteMobileTeamMember"],
  ["src/app/team-members.tsx", "updateMobileTeamMemberRole"],
  ["src/app/team-members.tsx", "removeMobileTeamMember"],
  ["src/app/team-crew.tsx", "createMobileTeamCrewMember"],
  ["src/app/team-crew.tsx", "updateMobileTeamCrewMember"],
  ["src/app/team-crew.tsx", "removeMobileTeamCrewMember"],
  ["src/app/team.tsx", "grantMobileTeamAccess"],
  ["src/app/team.tsx", "revokeMobileTeamAccess"],
  ["src/app/team.tsx", "<FlatList"],
  ["src/app/devices.tsx", "<FlatList"],
  ["src/app/timecode.tsx", "commandMobileTimecode"],
  ["src/app/cue-sheets.tsx", "writeMobileCueSheet"],
  ["src/app/asset-inventory.tsx", "createMobileAsset"],
  ["src/app/asset-inventory.tsx", "updateMobileAsset"],
  ["src/app/asset-inventory.tsx", "removeMobileAsset"],
  ["src/app/stream.tsx", "refetchInterval: 5_000"],
  ["src/app/multi-platform.tsx", "commandMobileDestination"],
  ["src/app/lower-thirds.tsx", "commandMobileGraphic"],
  ["src/components/manager-dashboard-screen.tsx", "getMobileDashboard"],
  ["src/app/reports.tsx", "Print.printToFileAsync"],
  ["src/app/reports.tsx", "Sharing.shareAsync"],
  ["src/app/audio.tsx", "createMobileAudioAssignment"],
  ["src/app/audio.tsx", "updateMobileAudioAssignment"],
  ["src/app/audio.tsx", "removeMobileAudioAssignment"],
  ["src/theme/tokens.ts", "themePreferenceStorageKey"],
  ["src/hooks/use-mobile-bootstrap.ts", "poll ? 5_000 : false"],
  ["src/lib/mobile-api.ts", "accessAuthoritySchema.optional()"],
  ["src/lib/mobile-api.ts", ")).default([])"],
  ["src/app/(app)/_layout.tsx", "useMobileBootstrap({ enabled: Boolean(session), poll: true })"],
  ["src/app/(app)/_layout.tsx", "isPending || organizationPending"],
  ["src/app/_layout.tsx", "<Stack.Protected guard={!session}>"],
  ["src/app/_layout.tsx", "<Stack.Protected guard={Boolean(session)}>"],
  ["src/app/_layout.tsx", "!session && error"],
  ["src/components/session-recovery-view.tsx", "Your sign-in is still stored safely on this device"],
  ["src/app/chat.tsx", "memo(function MessageCard"],
  ["src/app/schedule.tsx", "useLocalSearchParams"],
  ["src/app/schedule.tsx", "requestedAssignmentId"],
  ["src/lib/notification-route.ts", "assignmentId"],
];
const forbiddenSourceContract = [
  ["src/app/(app)/profile.tsx", "requestMediaLibraryPermissionsAsync"],
  ["src/app/show/[showId].tsx", "items.map((item"],
];
const apiContract = [
  "/api/mobile/v1/bootstrap",
  'url.pathname === "/api/mobile/v1/rundowns" && request.method === "POST"',
  "const rundownMatch",
  "/api/mobile/v1/schedule",
  "/api/mobile/v1/schedule/respond",
  "/api/mobile/v1/incidents",
  "/api/mobile/v1/incidents/history",
  "const incidentMatch",
  "const incidentCommentMatch",
  "const incidentReactionMatch",
  "/api/mobile/v1/checklist/items",
  "/api/mobile/v1/checklist/suggestions",
  "const checklistEntryMatch",
  "const checklistTemplateMatch",
  "/api/mobile/v1/checkin",
  "/api/mobile/v1/show-board",
  "/api/mobile/v1/show-workspace",
  "const checkInMemberMatch",
  "/api/mobile/v1/team/members",
  "/api/mobile/v1/team/invitations",
  "const teamInvitationMatch",
  "const teamMemberMatch",
  "/api/mobile/v1/team/crew",
  "const teamCrewMatch",
  "/api/mobile/v1/team/access",
  "const teamGrantMatch",
  "/api/mobile/v1/devices",
  "const deviceControlMatch",
  "/api/mobile/v1/cue-sheets",
  "/api/mobile/v1/assets",
  "const mobileAssetMatch",
  "/api/mobile/v1/streaming",
  "/api/mobile/v1/streaming/destinations",
  "const mobileDestinationMatch",
  "/api/mobile/v1/graphics",
  "const mobileGraphicMatch",
  "const mobileDashboardMatch",
  "/api/mobile/v1/reports",
  "/api/mobile/v1/audio",
  "const mobileAudioMatch",
  "/api/mobile/v1/notifications/read",
  "/api/mobile/v1/push-token",
];
const buildProfiles = {
  development: {
    developmentClient: true,
    distribution: "internal",
    environment: "development",
    channel: "development",
  },
  preview: {
    distribution: "internal",
    environment: "preview",
    channel: "preview",
  },
  production: {
    distribution: "store",
    environment: "production",
    channel: "production",
    autoIncrement: true,
  },
};
const workflowContracts = [
  {
    path: ".eas/workflows/create-internal-builds.yml",
    profile: "preview",
  },
  {
    path: ".eas/workflows/create-production-builds.yml",
    profile: "production",
  },
];
const storeDocumentContracts = [
  ["store/README.md", "Do not commit App Review passwords"],
  ["store/listing/en-US.md", "Run synchronized shows, crews, cues, timers, chat, and production devices."],
  ["store/privacy-data-safety.md", "https://showpilot.tech/delete-account"],
  ["store/screenshots.md", "1320 × 2868"],
  ["store/screenshots.md", "2064 × 2752"],
  ["store/screenshots.md", "1024 × 500"],
  ["store/submission-gates.md", "`0035_reports_and_moderation.sql`"],
];

function extractWebNavigation(source) {
  const navigation = [];
  for (const name of ["mainNav", "productionNav", "streamingNav", "dashboardNav"]) {
    const block = source.match(new RegExp(`const ${name}: NavItem\\[\\] = \\[([\\s\\S]*?)\\n\\];`))?.[1];
    if (!block) throw new Error(`Unable to read ${name} from the web Sidebar.`);
    for (const match of block.matchAll(/label:\s*"([^"]+)"[\s\S]*?path:\s*"([^"]+)"/g)) {
      navigation.push({ label: match[1], webPath: match[2] });
    }
  }
  return navigation;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function readPngHeader(relativePath) {
  const bytes = readFileSync(resolve(mobileRoot, relativePath));
  if (bytes.length < 26 || bytes.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${relativePath} is not a valid PNG asset.`);
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes[25],
  };
}

const workerApi = readFileSync(resolve(repositoryRoot, "apps/web/src/lib/mobile-api.server.ts"), "utf8");
const workerEntry = readFileSync(resolve(repositoryRoot, "apps/web/src/server.ts"), "utf8");
const serverContract = `${workerApi}\n${workerEntry}`;
const webSidebar = readFileSync(resolve(repositoryRoot, parityConfig.source), "utf8");
const webNavigation = extractWebNavigation(webSidebar);
if (parityConfig.version !== 1 || !Array.isArray(parityConfig.surfaces)) {
  throw new Error("parity.config.json must use schema version 1 and define surfaces.");
}
if (parityConfig.surfaces.length !== webNavigation.length) {
  throw new Error(
    `Native parity inventory has ${parityConfig.surfaces.length} surfaces; web navigation has ${webNavigation.length}.`,
  );
}
const parityIds = new Set();
const parityPaths = new Set();
const parityStatuses = new Set(["complete", "partial", "missing"]);
for (const [index, surface] of parityConfig.surfaces.entries()) {
  const webSurface = webNavigation[index];
  if (surface.label !== webSurface.label || surface.webPath !== webSurface.webPath) {
    throw new Error(
      `Parity surface ${index + 1} must match web navigation ${webSurface.label} (${webSurface.webPath}).`,
    );
  }
  if (typeof surface.id !== "string" || !surface.id || parityIds.has(surface.id)) {
    throw new Error(`Parity surface IDs must be non-empty and unique: ${String(surface.id)}.`);
  }
  if (parityPaths.has(surface.webPath)) {
    throw new Error(`Parity web paths must be unique: ${surface.webPath}.`);
  }
  parityIds.add(surface.id);
  parityPaths.add(surface.webPath);
  if (!parityStatuses.has(surface.status)) {
    throw new Error(`Unknown parity status for ${surface.label}: ${String(surface.status)}.`);
  }
  if (!Array.isArray(surface.nativeRoutes) || !Array.isArray(surface.apiContracts)) {
    throw new Error(`Parity evidence for ${surface.label} must use route and API arrays.`);
  }
  if (typeof surface.gaps !== "string") {
    throw new Error(`Parity gaps for ${surface.label} must be a string.`);
  }
  if (surface.status === "missing") {
    if (surface.nativeRoutes.length > 0 || surface.apiContracts.length > 0 || !surface.gaps) {
      throw new Error(`Missing surface ${surface.label} must have only a clear gap statement.`);
    }
    continue;
  }
  if (surface.nativeRoutes.length === 0) {
    throw new Error(`${surface.status} surface ${surface.label} must cite at least one native route.`);
  }
  for (const route of surface.nativeRoutes) {
    if (!existsSync(resolve(mobileRoot, route))) {
      throw new Error(`Parity evidence route for ${surface.label} is missing: ${route}.`);
    }
  }
  for (const endpoint of surface.apiContracts) {
    if (!serverContract.includes(endpoint)) {
      throw new Error(`Parity API evidence for ${surface.label} is missing: ${endpoint}.`);
    }
  }
  if (surface.status === "complete" && (surface.apiContracts.length === 0 || surface.gaps !== "")) {
    throw new Error(`Complete surface ${surface.label} needs API evidence and no recorded gaps.`);
  }
  if (surface.status === "partial" && !surface.gaps) {
    throw new Error(`Partial surface ${surface.label} must name its remaining gap.`);
  }
}
for (const [screen, endpoint] of featureContract) {
  if (!existsSync(resolve(mobileRoot, screen))) throw new Error(`Missing native screen: ${screen}`);
  if (!serverContract.includes(endpoint)) throw new Error(`Missing Worker endpoint: ${endpoint}`);
}
for (const [file, marker] of sourceContract) {
  const source = readFileSync(resolve(mobileRoot, file), "utf8");
  if (!source.includes(marker)) throw new Error(`Missing ${marker} from ${file}`);
}
for (const [file, marker] of forbiddenSourceContract) {
  const source = readFileSync(resolve(mobileRoot, file), "utf8");
  if (source.includes(marker)) throw new Error(`Unexpected ${marker} in ${file}`);
}
const rootLayout = readFileSync(resolve(mobileRoot, "src/app/_layout.tsx"), "utf8");
const signedOutRoutes = rootLayout.match(
  /<Stack\.Protected guard=\{!session\}>([\s\S]*?)<\/Stack\.Protected>/,
)?.[1];
const signedInRoutes = rootLayout.match(
  /<Stack\.Protected guard=\{Boolean\(session\)\}>([\s\S]*?)<\/Stack\.Protected>/,
)?.[1];
if (!signedOutRoutes?.includes('name="(auth)"')) {
  throw new Error("Native authentication screens must remain inside the signed-out route guard.");
}
for (const route of ["organizations", "(app)", "settings", "show/[showId]", "live-show", "timecode", "schedule", "chat", "incidents", "incidents-history", "checklist", "cue-sheets", "checkin", "show-board", "team", "devices", "device/[deviceId]", "asset-inventory", "stream", "multi-platform", "lower-thirds", "prod-manager", "reports", "tech-manager", "audio"]) {
  const marker = `name="${route}"`;
  if (!signedInRoutes?.includes(marker) || rootLayout.split(marker).length !== 2) {
    throw new Error(`Native protected route must appear exactly once inside the signed-in guard: ${route}`);
  }
}
for (const file of sourceFiles(resolve(mobileRoot, "src"))) {
  const source = readFileSync(file, "utf8");
  const undersizedText = [...source.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)/g)]
    .filter((match) => Number(match[1]) < 11);
  if (undersizedText.length > 0) {
    throw new Error(`Native text must be at least 11pt to remain legible and avoid clipping: ${file}`);
  }
  if (/from ["']lucide-react-native["']/.test(source)) {
    throw new Error(
      `Native icons must use direct lucide-react-native/icons/* imports to preserve tree shaking: ${file}`,
    );
  }
  if (/as unknown as Href/.test(source)) {
    throw new Error(`Native routes must satisfy Expo's generated Href types without double casts: ${file}`);
  }
  const anonymousControls = findAnonymousJsxControls(source, {
    filePath: file,
    tagNames: ["Pressable", "TouchableHighlight", "TouchableOpacity"],
    nameAttributes: ["accessibilityLabel", "accessibilityLabelledBy", "aria-label"],
  });
  if (anonymousControls.length > 0) {
    throw new Error(
      `Native icon-only controls need an accessibilityLabel or visible text: ${anonymousControls.map((line) => `${file}:${line}`).join(", ")}`,
    );
  }
}
for (const endpoint of apiContract) {
  if (!workerApi.includes(endpoint)) throw new Error(`Missing Worker endpoint: ${endpoint}`);
}
if (packageConfig.version !== appConfig.expo?.version) {
  throw new Error(
    `Mobile package and app versions must match (package=${String(packageConfig.version)}, app=${String(appConfig.expo?.version)}).`,
  );
}
if (appConfig.expo?.runtimeVersion?.policy !== "appVersion") {
  throw new Error("Mobile runtimeVersion must use the appVersion compatibility policy.");
}
if (easConfig.cli?.version !== ">= 22.4.0 < 23.0.0") {
  throw new Error("eas.json must enforce the reviewed EAS CLI major version.");
}
if (easConfig.cli?.appVersionSource !== "remote") {
  throw new Error("EAS must manage native build numbers remotely.");
}
for (const [profile, expected] of Object.entries(buildProfiles)) {
  const actual = easConfig.build?.[profile];
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      throw new Error(`EAS ${profile}.${key} must be ${String(value)}.`);
    }
  }
}
if (!easConfig.submit || typeof easConfig.submit.production !== "object") {
  throw new Error("EAS must retain an explicit production submit profile.");
}
if (storeConfig.configVersion !== 0 || !storeConfig.apple) {
  throw new Error("store.config.json must use the reviewed EAS Metadata schema version 0.");
}
const appleStoreInfo = storeConfig.apple.info?.["en-US"];
if (!appleStoreInfo) throw new Error("Apple metadata must include the en-US locale.");
for (const [field, minimum, maximum] of [
  ["title", 2, 30],
  ["subtitle", 1, 30],
  ["description", 10, 4_000],
  ["promoText", 1, 170],
]) {
  const value = appleStoreInfo[field];
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`Apple ${field} must be ${minimum}–${maximum} characters.`);
  }
}
if (!Array.isArray(appleStoreInfo.keywords) || new Set(appleStoreInfo.keywords).size !== appleStoreInfo.keywords.length) {
  throw new Error("Apple keywords must be a unique list.");
}
if (appleStoreInfo.keywords.join(",").length > 100) {
  throw new Error("Apple keywords must fit the 100-character App Store field.");
}
const requiredStoreUrls = {
  marketingUrl: "https://showpilot.tech",
  supportUrl: "https://showpilot.tech/support",
  privacyPolicyUrl: "https://showpilot.tech/privacy",
  privacyChoicesUrl: "https://showpilot.tech/delete-account",
};
for (const [field, expected] of Object.entries(requiredStoreUrls)) {
  if (appleStoreInfo[field] !== expected) throw new Error(`Apple ${field} must remain ${expected}.`);
}
if (storeConfig.apple.categories?.join(",") !== "BUSINESS,PRODUCTIVITY") {
  throw new Error("Apple categories must remain Business and Productivity.");
}
if (storeConfig.apple.release?.automaticRelease !== false) {
  throw new Error("The first mobile release must require manual release after store approval.");
}
if (storeConfig.apple.advisory?.unrestrictedWebAccess !== false || storeConfig.apple.advisory?.gambling !== false) {
  throw new Error("Apple age-rating answers do not match the submitted app.");
}
for (const [path, marker] of storeDocumentContracts) {
  const source = readFileSync(resolve(mobileRoot, path), "utf8");
  if (!source.includes(marker)) throw new Error(`Missing store-readiness marker ${marker} from ${path}`);
}
const googleListing = readFileSync(resolve(mobileRoot, "store/listing/en-US.md"), "utf8");
const googleTitle = googleListing.match(/Title \([^)]*\):\s*\n\s*> ([^\n]+)/)?.[1];
const googleShortDescription = googleListing.match(/Short description \([^)]*\):\s*\n\s*> ([^\n]+)/)?.[1];
if (!googleTitle || googleTitle.length > 30) throw new Error("Google Play title must be present and at most 30 characters.");
if (!googleShortDescription || googleShortDescription.length > 80) {
  throw new Error("Google Play short description must be present and at most 80 characters.");
}
const mobileSettingsSource = readFileSync(resolve(mobileRoot, "src/app/settings.tsx"), "utf8");
if (!mobileSettingsSource.includes('openExternal("/delete-account")')) {
  throw new Error("Native Settings must retain the in-app account-deletion entry point.");
}
for (const route of ["support.tsx", "delete-account.tsx", "account-deleted.tsx", "privacy.tsx"]) {
  if (!existsSync(resolve(repositoryRoot, "apps/web/src/routes", route))) {
    throw new Error(`The public store resource is missing: ${route}`);
  }
}
for (const workflow of workflowContracts) {
  const source = readFileSync(resolve(mobileRoot, workflow.path), "utf8");
  const config = parseYaml(source);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`${workflow.path} must contain a YAML object.`);
  }
  if (Object.hasOwn(config, "on")) {
    throw new Error(`${workflow.path} must remain manually triggered.`);
  }
  if (!config.jobs || typeof config.jobs !== "object" || Array.isArray(config.jobs)) {
    throw new Error(`${workflow.path} must define build jobs.`);
  }
  const jobs = Object.values(config.jobs);
  if (jobs.length !== 2) {
    throw new Error(`${workflow.path} must contain exactly two build jobs.`);
  }
  const platforms = jobs.map((job) => job?.params?.platform).sort();
  if (platforms.join(",") !== "android,ios") {
    throw new Error(`${workflow.path} must build exactly Android and iOS.`);
  }
  for (const job of jobs) {
    if (job?.type !== "build" || job.params?.profile !== workflow.profile) {
      throw new Error(`${workflow.path} must remain build-only with the ${workflow.profile} profile.`);
    }
  }
}
for (const [packageName, expectedVersion] of Object.entries(runtimeVersions)) {
  const packageJsonPath = realpathSync(resolve(mobileRoot, "node_modules", packageName, "package.json"));
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.version !== expectedVersion) {
    throw new Error(`Expected ${packageName} ${expectedVersion}, resolved ${String(packageJson.version)}`);
  }
}
const resolveFromExpo = createRequire(realpathSync(resolve(mobileRoot, "node_modules", "expo", "package.json")));
const expoModulesCoreEntry = resolveFromExpo.resolve("expo-modules-core");
const expoModulesCorePackage = JSON.parse(readFileSync(resolve(dirname(expoModulesCoreEntry), "..", "package.json"), "utf8"));
if (expoModulesCorePackage.version !== "3.0.30") {
  throw new Error(`Expected expo-modules-core 3.0.30, resolved ${String(expoModulesCorePackage.version)}`);
}

const publicConfig = JSON.parse(execFileSync(
  "pnpm",
  ["exec", "expo", "config", "--type", "public", "--json"],
  { cwd: mobileRoot, encoding: "utf8" },
));
if (publicConfig.ios?.bundleIdentifier !== "tech.showpilot.mobile") {
  throw new Error("The iOS bundle identifier changed from tech.showpilot.mobile.");
}
if (appConfig.expo?.ios?.config?.usesNonExemptEncryption !== false) {
  throw new Error("The iOS export-compliance declaration must remain explicit.");
}
if (publicConfig.android?.package !== "tech.showpilot.mobile") {
  throw new Error("The Android application ID changed from tech.showpilot.mobile.");
}
const projectId = publicConfig.extra?.eas?.projectId;
const owner = publicConfig.owner;
const updatesUrl = publicConfig.updates?.url;
if (projectId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
  throw new Error("The linked EAS project ID must be a UUID.");
}
if (projectId && updatesUrl !== `https://u.expo.dev/${projectId}`) {
  throw new Error("The EAS Update URL must match the linked project ID.");
}
if (!projectId && updatesUrl) {
  throw new Error("The app cannot declare an EAS Update URL without a project ID.");
}
if (requireReleaseLink && !projectId) {
  throw new Error("Release verification requires extra.eas.projectId from the approved EAS project.");
}
if (requireReleaseLink && (typeof owner !== "string" || owner.length === 0)) {
  throw new Error("Release verification requires the approved Expo account owner.");
}
const androidPermissions = Array.isArray(publicConfig.android?.permissions)
  ? publicConfig.android.permissions
  : [];
const blockedAndroidPermissions = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];
for (const permission of blockedAndroidPermissions) {
  if (androidPermissions.includes(permission)) {
    throw new Error(`The mobile app must not request unused ${permission} access.`);
  }
  if (!appConfig.expo?.android?.blockedPermissions?.includes(permission)) {
    throw new Error(`app.json must explicitly block unused ${permission} access.`);
  }
}
const appIcon = readPngHeader("assets/showpilot-app-icon.png");
if (appIcon.width !== 1024 || appIcon.height !== 1024 || [4, 6].includes(appIcon.colorType)) {
  throw new Error("The store icon must be an opaque 1024x1024 PNG.");
}
const adaptiveForeground = readPngHeader("assets/showpilot-adaptive-foreground.png");
if (adaptiveForeground.width !== 1024 || adaptiveForeground.height !== 1024) {
  throw new Error("The Android adaptive foreground must be a 1024x1024 PNG.");
}

const commands = [
  ["exec", "tsc", "--noEmit"],
  ["exec", "expo", "lint"],
  // Export each target sequentially. Metro's `all` mode can exhaust a worker
  // while native Hermes compilation and web static rendering run together,
  // leaving CI waiting forever after the native bundles have completed.
  ["exec", "expo", "export", "--platform", "ios", "--output-dir", "dist/ios", "--clear"],
  ["exec", "expo", "export", "--platform", "android", "--output-dir", "dist/android", "--clear"],
  ["exec", "expo", "export", "--platform", "web", "--output-dir", "dist/web", "--clear"],
  ["dlx", "expo-doctor", "."],
];

for (const args of commands) {
  execFileSync("pnpm", args, { cwd: mobileRoot, stdio: "inherit" });
}

for (const platform of ["ios", "android"]) {
  const bundleDirectory = resolve(mobileRoot, "dist", platform, "_expo", "static", "js", platform);
  const bundles = readdirSync(bundleDirectory).filter((name) => name.endsWith(".hbc"));
  if (bundles.length !== 1) {
    throw new Error(`Expected one ${platform} Hermes bundle, found ${bundles.length}.`);
  }
  const bundleBytes = statSync(resolve(bundleDirectory, bundles[0])).size;
  if (bundleBytes > maximumNativeBundleBytes) {
    throw new Error(
      `${platform} Hermes bundle is ${bundleBytes} bytes; maximum is ${maximumNativeBundleBytes}. ` +
      "Inspect imports for package barrels or unused native dependencies.",
    );
  }
  console.log(`${platform} Hermes bundle: ${bundleBytes} / ${maximumNativeBundleBytes} bytes.`);
}

const releaseState = projectId
  ? `linked EAS project ${projectId}`
  : "local app contracts; EAS project linkage remains pending";
const parityCounts = Object.fromEntries(
  [...parityStatuses].map((status) => [
    status,
    parityConfig.surfaces.filter((surface) => surface.status === status).length,
  ]),
);
console.log(
  `Native parity inventory: ${parityCounts.complete} complete, ${parityCounts.partial} partial, ` +
  `${parityCounts.missing} missing of ${parityConfig.surfaces.length} web product surfaces.`,
);
console.log(`Verified ${featureContract.length + 1} native screens, settings persistence, ${apiContract.length} API contracts, store metadata, and ${releaseState} across iOS, Android, and web exports.`);
