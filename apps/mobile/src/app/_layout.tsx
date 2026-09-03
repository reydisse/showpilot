import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { LoadingView } from "@/components/loading-view";
import { SessionRecoveryView } from "@/components/session-recovery-view";
import { authClient } from "@/lib/auth-client";
import { AppProviders } from "@/providers/app-providers";
import { useAppTheme } from "@/theme/tokens";

export default function RootLayout() {
  return <AppProviders><RootNavigator /></AppProviders>;
}

function RootNavigator() {
  const { colors, statusBarStyle } = useAppTheme();
  const { data: session, error, isPending, isRefetching, refetch } = authClient.useSession();
  const [retrying, setRetrying] = useState(false);
  const [restoreTimedOut, setRestoreTimedOut] = useState(false);

  useEffect(() => {
    if (session || (!isPending && !isRefetching)) {
      setRestoreTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setRestoreTimedOut(true), 8_000);
    return () => clearTimeout(timer);
  }, [isPending, isRefetching, session]);

  async function retrySession() {
    if (retrying) return;
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  }

  if (!session && (isPending || isRefetching) && !restoreTimedOut) {
    return <LoadingView label="Restoring your session…" />;
  }
  if (!session && restoreTimedOut) {
    return <SessionRecoveryView error="Session restore took too long. Check your connection and try again." retrying={retrying} onRetry={() => void retrySession()} />;
  }
  if (!session && error) {
    return <SessionRecoveryView error={error.message} retrying={retrying} onRetry={() => void retrySession()} />;
  }

  return (
    <>
      <StatusBar style={statusBarStyle} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.stage },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.stage },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Protected guard={!session}>
          <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={Boolean(session)}>
          <Stack.Screen name="organizations" options={{ headerShown: false }} />
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ headerShown: false }} />
          <Stack.Screen name="show/[showId]" options={{ headerShown: false }} />
          <Stack.Screen name="live-show" options={{ headerShown: false }} />
          <Stack.Screen name="timecode" options={{ headerShown: false }} />
          <Stack.Screen name="schedule" options={{ headerShown: false }} />
          <Stack.Screen name="chat" options={{ headerShown: false }} />
          <Stack.Screen name="incidents" options={{ headerShown: false }} />
          <Stack.Screen name="incidents-history" options={{ headerShown: false }} />
          <Stack.Screen name="checklist" options={{ headerShown: false }} />
          <Stack.Screen name="cue-sheets" options={{ headerShown: false }} />
          <Stack.Screen name="checkin" options={{ headerShown: false }} />
          <Stack.Screen name="show-board" options={{ headerShown: false }} />
          <Stack.Screen name="team-members" options={{ headerShown: false }} />
          <Stack.Screen name="team-crew" options={{ headerShown: false }} />
          <Stack.Screen name="team" options={{ headerShown: false }} />
          <Stack.Screen name="devices" options={{ headerShown: false }} />
          <Stack.Screen name="device/[deviceId]" options={{ headerShown: false }} />
          <Stack.Screen name="asset-inventory" options={{ headerShown: false }} />
          <Stack.Screen name="stream" options={{ headerShown: false }} />
          <Stack.Screen name="multi-platform" options={{ headerShown: false }} />
          <Stack.Screen name="lower-thirds" options={{ headerShown: false }} />
          <Stack.Screen name="prod-manager" options={{ headerShown: false }} />
          <Stack.Screen name="reports" options={{ headerShown: false }} />
          <Stack.Screen name="tech-manager" options={{ headerShown: false }} />
          <Stack.Screen name="audio" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
