import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AppProviders } from "@/providers/app-providers";
import { useAppTheme } from "@/theme/tokens";

export default function RootLayout() {
  const { colors, statusBarStyle } = useAppTheme();
  return (
    <AppProviders>
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
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="organizations" options={{ headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
        <Stack.Screen name="show/[showId]" options={{ title: "Live rundown", headerBackTitle: "Shows" }} />
        <Stack.Screen name="schedule" options={{ title: "Schedule", headerBackTitle: "Operate" }} />
        <Stack.Screen name="chat" options={{ title: "Production chat", headerBackTitle: "Operate" }} />
        <Stack.Screen name="incidents" options={{ title: "Incidents", headerBackTitle: "Operate" }} />
        <Stack.Screen name="devices" options={{ title: "Devices", headerBackTitle: "Operate" }} />
        <Stack.Screen name="device/[deviceId]" options={{ title: "Device control", headerBackTitle: "Devices" }} />
      </Stack>
    </AppProviders>
  );
}
