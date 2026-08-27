import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
const appConfig = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8"));
const packageConfig = JSON.parse(readFileSync(resolve(mobileRoot, "package.json"), "utf8"));
const easConfig = JSON.parse(readFileSync(resolve(mobileRoot, "eas.json"), "utf8"));
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
  ["src/app/devices.tsx", "/api/mobile/v1/devices"],
  ["src/app/device/[deviceId].tsx", "const deviceControlMatch"],
  ["src/app/(app)/profile.tsx", "/api/user/avatar"],
];
const sourceContract = [
  ["src/app/(app)/shows.tsx", "createMobileRundown"],
  ["src/app/incidents.tsx", "getServiceDateForTimeZone"],
  ["src/app/settings.tsx", "setAppThemePreference"],
  ["src/app/settings.tsx", "getNativeNotificationPermissionState"],
  ["src/app/(app)/profile.tsx", 'router.push("/settings")'],
  ["src/app/(app)/inbox.tsx", "<FlatList"],
  ["src/app/(app)/shows.tsx", "<FlatList"],
  ["src/app/show/[showId].tsx", "function TimerPanel"],
  ["src/app/show/[showId].tsx", "<FlatList"],
  ["src/app/schedule.tsx", "<FlatList"],
  ["src/app/incidents.tsx", "<FlatList"],
  ["src/app/devices.tsx", "<FlatList"],
  ["src/theme/tokens.ts", "themePreferenceStorageKey"],
  ["src/hooks/use-mobile-bootstrap.ts", "poll ? 30_000 : false"],
  ["src/app/(app)/_layout.tsx", "useMobileBootstrap({ enabled: Boolean(session), poll: true })"],
  ["src/app/(app)/_layout.tsx", "isPending || organizationPending"],
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
  "/api/mobile/v1/devices",
  "const deviceControlMatch",
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
for (const file of sourceFiles(resolve(mobileRoot, "src"))) {
  const source = readFileSync(file, "utf8");
  if (/from ["']lucide-react-native["']/.test(source)) {
    throw new Error(
      `Native icons must use direct lucide-react-native/icons/* imports to preserve tree shaking: ${file}`,
    );
  }
  if (/as unknown as Href/.test(source)) {
    throw new Error(`Native routes must satisfy Expo's generated Href types without double casts: ${file}`);
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
  ["exec", "expo", "export", "--platform", "all", "--clear"],
  ["dlx", "expo-doctor", "."],
];

for (const args of commands) {
  execFileSync("pnpm", args, { cwd: mobileRoot, stdio: "inherit" });
}

for (const platform of ["ios", "android"]) {
  const bundleDirectory = resolve(mobileRoot, "dist", "_expo", "static", "js", platform);
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
console.log(`Verified ${featureContract.length + 1} native screens, settings persistence, ${apiContract.length} API contracts, and ${releaseState} across iOS, Android, and web exports.`);
