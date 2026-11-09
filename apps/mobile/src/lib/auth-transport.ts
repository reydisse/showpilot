import { Platform } from "react-native";
import { authClient } from "@/lib/auth-client";
import { getStoredRundownPin } from "@/lib/rundown-pin";
import { runMobileOperation, MobileOperationTimeoutError } from "./request-deadline";

type NativeWebSocketConstructor = new (
  uri: string,
  protocols?: string | string[] | null,
  options?: { headers: Record<string, string> } | null,
) => WebSocket;

export function getAuthenticatedFetchCredentials(): "include" | undefined {
  return Platform.OS === "web" ? "include" : undefined;
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
