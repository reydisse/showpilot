import type { QueryClient } from "@tanstack/react-query";
import { Platform } from "react-native";
import { authClient } from "@/lib/auth-client";
import { saveMobilePushToken } from "@/lib/mobile-api";
import { getNativePushToken } from "@/lib/native-notifications";

/** One account-exit path for every mobile sign-out surface. */
export async function exitMobileAccount(queryClient: QueryClient, organizationId?: string): Promise<void> {
  const token = await getNativePushToken().catch(() => null);
  if (token && organizationId && (Platform.OS === "ios" || Platform.OS === "android")) {
    await saveMobilePushToken(organizationId, token, Platform.OS, false).catch(() => undefined);
  }

  const result = await authClient.signOut();
  if (result.error) throw new Error(result.error.message || "Sign out could not be completed.");

  // Cancel before clearing so an old account's delayed response cannot
  // repopulate private data after the navigation changes identity.
  await queryClient.cancelQueries();
  queryClient.clear();
}
