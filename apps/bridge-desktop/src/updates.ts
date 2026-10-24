import { check } from "@tauri-apps/plugin-updater";

export type BridgeUpdateResult =
  | { kind: "current" }
  | { kind: "available"; version: string }
  | { kind: "installed"; version: string };

export async function runBridgeUpdate(action: "check" | "install"): Promise<BridgeUpdateResult> {
  const update = await check({ timeout: 30_000 });
  if (!update) return { kind: "current" };
  try {
    if (action === "check") return { kind: "available", version: update.version };
    await update.downloadAndInstall();
    return { kind: "installed", version: update.version };
  } finally {
    await update.close();
  }
}
