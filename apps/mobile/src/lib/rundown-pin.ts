import { Platform } from "react-native";

const PREFIX = "showpilot-rundown-pin:";
const memoryPins = new Map<string, string>();

function key(orgId: string): string {
  if (Platform.OS === "web") return `${PREFIX}${orgId}`;
  // SecureStore rejects colons. Escape underscores too, so distinct org IDs
  // cannot map to the same key. Browser session keys stay unchanged.
  const encodedOrgId = orgId.replace(/[^a-zA-Z0-9.-]/g, (character) => `_${character.charCodeAt(0).toString(16)}_`);
  return `showpilot-rundown-pin.${encodedOrgId}`;
}

export async function getStoredRundownPin(orgId: string): Promise<string | null> {
  if (!orgId) return null;
  if (Platform.OS === "web") {
    try {
      return window.sessionStorage.getItem(key(orgId));
    } catch {
      return memoryPins.get(orgId) ?? null;
    }
  }
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(key(orgId));
}

export async function setStoredRundownPin(orgId: string, pin: string): Promise<void> {
  const value = pin.trim();
  if (!orgId || !value) return;
  memoryPins.set(orgId, value);
  if (Platform.OS === "web") {
    try {
      window.sessionStorage.setItem(key(orgId), value);
    } catch {}
    return;
  }
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync(key(orgId), value);
}

export async function clearStoredRundownPin(orgId: string): Promise<void> {
  if (!orgId) return;
  memoryPins.delete(orgId);
  if (Platform.OS === "web") {
    try {
      window.sessionStorage.removeItem(key(orgId));
    } catch {}
    return;
  }
  const SecureStore = await import("expo-secure-store");
  await SecureStore.deleteItemAsync(key(orgId));
}

export function orgIdFromPinProtectedPath(path: string): string | null {
  if (
    !path.startsWith("/api/mobile/v1/rundowns/")
    && !path.startsWith("/api/mobile/v1/show-workspace")
  ) return null;
  try {
    return new URL(path, "https://showpilot.local").searchParams.get("orgId")?.trim() || null;
  } catch {
    return null;
  }
}
