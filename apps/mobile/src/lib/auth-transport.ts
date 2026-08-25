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

export function getNativeCookieHeader(): Record<string, string> {
  return Platform.OS === "web" ? {} : { Cookie: authClient.getCookie() };
}

export function createAuthenticatedWebSocket(url: string): WebSocket {
  if (Platform.OS === "web") return new WebSocket(url);

  const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
  return new NativeWebSocket(url, null, {
    headers: { Cookie: authClient.getCookie() },
  });
}
