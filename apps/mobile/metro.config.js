const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const expoPackageRoot = path.dirname(require.resolve("expo/package.json", { paths: [__dirname] }));
const expoModulesCore = require.resolve("expo-modules-core", { paths: [expoPackageRoot] });

// pnpm can keep multiple Expo SDKs in the workspace store. Resolve the native
// module runtime owned by Expo 54 instead of following a stale hoisted copy.
config.resolver.resolveRequest = (context, moduleName, platform) => context.resolveRequest(
  context,
  moduleName === "expo-modules-core" ? expoModulesCore : moduleName,
  platform,
);

module.exports = config;
