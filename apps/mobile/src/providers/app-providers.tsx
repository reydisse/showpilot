import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Network from "expo-network";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState, type PropsWithChildren } from "react";
import { AppState, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useAppTheme } from "@/theme/tokens";

if (Platform.OS !== "web") {
  void import("expo-notifications").then((Notifications) => {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  }).catch(() => {
    // Notification setup must never block the application from starting.
  });

  onlineManager.setEventListener((setOnline) => {
    const updateOnlineState = (state: Network.NetworkState) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    };
    void Network.getNetworkStateAsync().then(updateOnlineState).catch(() => setOnline(true));
    const subscription = Network.addNetworkStateListener(updateOnlineState);
    return () => subscription.remove();
  });
}

export function AppProviders({ children }: PropsWithChildren) {
  const { colors } = useAppTheme();
  const [queryClient] = useState(
    () => new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 15_000,
          retry: 1,
          refetchOnReconnect: "always",
          refetchOnWindowFocus: "always",
          refetchIntervalInBackground: false,
        },
      },
    }),
  );

  useEffect(() => {
    if (Platform.OS === "android") void SystemUI.setBackgroundColorAsync(colors.stage);
  }, [colors.stage]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    let previousState = AppState.currentState;
    focusManager.setFocused(previousState === "active");
    const subscription = AppState.addEventListener("change", (state) => {
      const returningToForeground = previousState !== "active" && state === "active";
      previousState = state;
      focusManager.setFocused(state === "active");
      if (state !== "active") {
        void queryClient.cancelQueries();
      } else if (returningToForeground) {
        // Refetch only mounted screens. This avoids a thundering herd after a
        // long background period while still restoring live control state.
        void queryClient.invalidateQueries({ refetchType: "active" });
      }
    });
    return () => {
      subscription.remove();
      focusManager.setFocused(undefined);
    };
  }, [queryClient]);

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
}
