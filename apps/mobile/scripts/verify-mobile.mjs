import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
const appConfig = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8"));
const runtimeVersions = {
  expo: "54.0.37",
  "react-native": "0.81.5",
};
const featureContract = [
  ["src/app/(app)/shows.tsx", "/api/mobile/v1/bootstrap"],
  ["src/app/schedule.tsx", "/api/mobile/v1/schedule"],
  ["src/app/incidents.tsx", "/api/mobile/v1/incidents"],
  ["src/app/devices.tsx", "/api/mobile/v1/devices"],
  ["src/app/device/[deviceId].tsx", "const deviceControlMatch"],
  ["src/app/(app)/profile.tsx", "/api/user/avatar"],
];
const sourceContract = [
  ["src/app/settings.tsx", "setAppThemePreference"],
  ["src/app/settings.tsx", "getNativeNotificationPermissionState"],
  ["src/app/(app)/profile.tsx", 'router.push("/settings")'],
  ["src/theme/tokens.ts", "themePreferenceStorageKey"],
];
const apiContract = [
  "/api/mobile/v1/bootstrap",
  "const rundownMatch",
  "/api/mobile/v1/schedule",
  "/api/mobile/v1/schedule/respond",
  "/api/mobile/v1/incidents",
  "/api/mobile/v1/devices",
  "const deviceControlMatch",
  "/api/mobile/v1/notifications/read",
  "/api/mobile/v1/push-token",
];

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
for (const endpoint of apiContract) {
  if (!workerApi.includes(endpoint)) throw new Error(`Missing Worker endpoint: ${endpoint}`);
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
const androidPermissions = Array.isArray(publicConfig.android?.permissions)
  ? publicConfig.android.permissions
  : [];
for (const permission of ["android.permission.CAMERA", "android.permission.RECORD_AUDIO"]) {
  if (androidPermissions.includes(permission)) {
    throw new Error(`The profile-photo picker must not request unused ${permission} access.`);
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

console.log(`Verified ${featureContract.length + 1} native screens, settings persistence, and ${apiContract.length} API contracts across iOS, Android, and web exports.`);
