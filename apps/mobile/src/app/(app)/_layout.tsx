import { Bell, CalendarDays, Gauge, PanelsTopLeft, UserRound } from "lucide-react-native";
import { Redirect, Tabs } from "expo-router";
import { LoadingView } from "@/components/loading-view";
import { useNativePushRegistration } from "@/hooks/use-native-push-registration";
import { authClient } from "@/lib/auth-client";
import { fontFamily, useAppTheme } from "@/theme/tokens";

export default function AppLayout() {
  const { colors } = useAppTheme();
  const { data: session, isPending } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  useNativePushRegistration(organization?.id);
  if (isPending) return <LoadingView />;
  if (!session) return <Redirect href="/sign-in" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.amberText,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: { backgroundColor: colors.stageRaised, borderTopColor: colors.borderSoft, height: 66, paddingTop: 6 },
        tabBarLabelStyle: { fontFamily, fontSize: 11, fontWeight: "700", paddingBottom: 6 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: ({ color, size }) => <Gauge color={color} size={size} /> }} />
      <Tabs.Screen name="shows" options={{ title: "Shows", tabBarIcon: ({ color, size }) => <CalendarDays color={color} size={size} /> }} />
      <Tabs.Screen name="operations" options={{ title: "Operate", tabBarIcon: ({ color, size }) => <PanelsTopLeft color={color} size={size} /> }} />
      <Tabs.Screen name="inbox" options={{ title: "Inbox", tabBarIcon: ({ color, size }) => <Bell color={color} size={size} /> }} />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: ({ color, size }) => <UserRound color={color} size={size} /> }} />
    </Tabs>
  );
}
