import * as ReactNative from "react-native";
import { authClient } from "@/lib/auth-client";
import { getStoredRundownPin } from "@/lib/rundown-pin";
import { runMobileOperation, MobileOperationTimeoutError } from "./request-deadline";

const { Platform } = ReactNative;

type NativeWebSocketConstructor = new (
  uri: string,
  protocols?: string | string[] | null,
  options?: { headers: Record<string, string> } | null,
) => WebSocket;

export function getAuthenticatedFetchCredentials(): "include" | "omit" {
  // Expo fetch defaults to include. Native auth belongs to SecureStore, not
  // the ambient URLSession cookie jar, which may contain an older account.
  return Platform.OS === "web" ? "include" : "omit";
}

function clearAmbientNativeCookies(): Promise<void> {
  const networking = ReactNative.TurboModuleRegistry.get<ReactNative.TurboModule & {
    clearCookies?: (callback: (hadCookies: boolean) => void) => void;
  }>("Networking");
  if (!networking?.clearCookies) {
    return Promise.reject(new Error("Native connection cookie isolation is unavailable. Restart the app and retry."));
  }
  // RN WebSocket always prepends the app's native cookie jar before adding
  // supplied headers. Clear only that app-local jar; SecureStore is untouched.
  // A false callback means the jar was already empty, not a cleanup failure.
  return new Promise<void>((resolve) => {
    networking.clearCookies!(() => resolve());
  });
}

export async function getNativeCookieHeader(): Promise<Record<string, string>> {
  return Platform.OS === "web" ? {} : { Cookie: await authClient.getCookie() };
}

export async function createAuthenticatedWebSocket(url: string, orgId?: string, signal?: AbortSignal): Promise<WebSocket> {
  try {
    return await runMobileOperation(async (controller) => {
      if (Platform.OS === "web") return new WebSocket(url);
      const [cookie, rundownPin] = await Promise.all([
        authClient.getCookie(),
        orgId ? getStoredRundownPin(orgId) : Promise.resolve(null),
      ]);
      controller.signal.throwIfAborted();
      await clearAmbientNativeCookies();
      // SecureStore cannot be cancelled. Never create a socket from its late result.
      if (controller.signal.aborted) throw new Error("Live connection cancelled.");
      const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
      return new NativeWebSocket(url, null, {
        headers: {
          Cookie: cookie,
          ...(rundownPin ? { "x-showpilot-rundown-pin": rundownPin } : {}),
        },
      });
    }, signal, 10_000);
  } catch (error) {
    if (error instanceof MobileOperationTimeoutError)
      throw new Error("Live authentication timed out. Retry the connection.");
    throw error;
  }
}
