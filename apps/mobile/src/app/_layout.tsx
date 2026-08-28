import { useEffect, useState } from "react";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable } from "react-native";
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
          <Stack.Screen
            name="settings"
            options={{
              title: "Settings",
              headerBackVisible: false,
              headerLeft: () => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to profile"
                  hitSlop={12}
                  onPress={() => router.canGoBack() ? router.back() : router.replace("/(app)/profile")}
                  style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1, padding: 4, marginLeft: -4 })}
                >
                  <ChevronLeft size={25} color={colors.text} />
                </Pressable>
              ),
            }}
          />
          <Stack.Screen name="show/[showId]" options={{ title: "Live rundown", headerBackTitle: "Shows" }} />
          <Stack.Screen name="live-show" options={{ title: "Live Show", headerBackTitle: "Shows" }} />
          <Stack.Screen name="timecode" options={{ title: "Timecode", headerBackTitle: "Operate" }} />
          <Stack.Screen name="schedule" options={{ title: "Schedule", headerBackTitle: "Operate" }} />
          <Stack.Screen name="chat" options={{ title: "Production chat", headerBackTitle: "Operate" }} />
          <Stack.Screen name="incidents" options={{ title: "Incidents", headerBackTitle: "Operate" }} />
          <Stack.Screen name="incidents-history" options={{ title: "Incident history", headerBackTitle: "Incidents" }} />
          <Stack.Screen name="checklist" options={{ title: "Pre-show checklist", headerBackTitle: "Operate" }} />
          <Stack.Screen name="cue-sheets" options={{ title: "Cue Sheets", headerBackTitle: "Operate" }} />
          <Stack.Screen name="checkin" options={{ title: "Crew check-in", headerBackTitle: "Operate" }} />
          <Stack.Screen name="show-board" options={{ title: "Show Board", headerBackTitle: "Operate" }} />
          <Stack.Screen name="team-members" options={{ title: "Organization members", headerBackTitle: "Operate" }} />
          <Stack.Screen name="team-crew" options={{ title: "Crew roster", headerBackTitle: "Operate" }} />
          <Stack.Screen name="team" options={{ title: "Team access", headerBackTitle: "Operate" }} />
          <Stack.Screen name="devices" options={{ title: "Devices", headerBackTitle: "Operate" }} />
          <Stack.Screen name="device/[deviceId]" options={{ title: "Device control", headerBackTitle: "Devices" }} />
          <Stack.Screen name="asset-inventory" options={{ title: "Assets", headerBackTitle: "Operate" }} />
          <Stack.Screen name="stream" options={{ title: "Stream Health", headerBackTitle: "Operate" }} />
          <Stack.Screen name="multi-platform" options={{ title: "Multi-Platform", headerBackTitle: "Operate" }} />
          <Stack.Screen name="lower-thirds" options={{ title: "Lower Thirds", headerBackTitle: "Operate" }} />
          <Stack.Screen name="prod-manager" options={{ title: "Prod Manager", headerBackTitle: "Operate" }} />
          <Stack.Screen name="reports" options={{ title: "Reports", headerBackTitle: "Operate" }} />
          <Stack.Screen name="tech-manager" options={{ title: "Tech Manager", headerBackTitle: "Operate" }} />
          <Stack.Screen name="audio" options={{ title: "Audio", headerBackTitle: "Operate" }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
