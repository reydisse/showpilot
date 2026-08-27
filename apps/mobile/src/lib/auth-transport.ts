import { Platform } from "react-native";
import { authClient } from "@/lib/auth-client";

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

export async function createAuthenticatedWebSocket(url: string): Promise<WebSocket> {
  if (Platform.OS === "web") return new WebSocket(url);

  const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
  return new NativeWebSocket(url, null, {
    headers: { Cookie: await authClient.getCookie() },
  });
}
