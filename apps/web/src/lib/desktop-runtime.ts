export type DesktopEngineInfo = {
  native: boolean;
  platform: string;
  version: string;
  cachePath: string | null;
};

export type DesktopWindowKind = "timer" | "show-board" | "check-in";

type TauriCore = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCore };
  }
}

function getTauriCore(): TauriCore | null {
  if (typeof window === "undefined") return null;
  return window.__TAURI__?.core ?? null;
}

export function isDesktopRuntime(): boolean {
  return getTauriCore() !== null;
}

export async function getDesktopEngineInfo(): Promise<DesktopEngineInfo | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<DesktopEngineInfo>("engine_info");
}

export async function openDesktopWindow(
  kind: DesktopWindowKind,
  orgSlug: string,
): Promise<void> {
  const core = getTauriCore();
  if (!core) throw new Error("ShowPilot Desktop is not available");
  await core.invoke("open_companion_window", { kind, orgSlug });
}

export async function cacheDesktopService(payload: unknown): Promise<string | null> {
  const core = getTauriCore();
  if (!core) return null;
  return core.invoke<string>("cache_service", {
    payload: JSON.stringify(payload),
  });
}
