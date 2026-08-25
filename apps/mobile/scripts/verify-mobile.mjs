import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(mobileRoot, "../..");
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

const workerApi = readFileSync(resolve(repositoryRoot, "apps/web/src/lib/mobile-api.server.ts"), "utf8");
const workerEntry = readFileSync(resolve(repositoryRoot, "apps/web/src/server.ts"), "utf8");
const serverContract = `${workerApi}\n${workerEntry}`;
for (const [screen, endpoint] of featureContract) {
  if (!existsSync(resolve(mobileRoot, screen))) throw new Error(`Missing native screen: ${screen}`);
  if (!serverContract.includes(endpoint)) throw new Error(`Missing Worker endpoint: ${endpoint}`);
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

const commands = [
  ["exec", "tsc", "--noEmit"],
  ["exec", "expo", "lint"],
  ["exec", "expo", "export", "--platform", "all", "--clear"],
  ["dlx", "expo-doctor", "."],
];

for (const args of commands) {
  execFileSync("pnpm", args, { cwd: mobileRoot, stdio: "inherit" });
}

console.log(`Verified ${featureContract.length} native screens and ${apiContract.length} API contracts across iOS, Android, and web exports.`);
