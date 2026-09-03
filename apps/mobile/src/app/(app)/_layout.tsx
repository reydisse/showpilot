import { useEffect, useState } from "react";
import Bell from "lucide-react-native/icons/bell";
import CalendarDays from "lucide-react-native/icons/calendar-days";
import Gauge from "lucide-react-native/icons/gauge";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import UserRound from "lucide-react-native/icons/user-round";
import { Redirect, Tabs } from "expo-router";
import { LoadingView } from "@/components/loading-view";
import { SessionRecoveryView } from "@/components/session-recovery-view";
import { useNativePushRegistration } from "@/hooks/use-native-push-registration";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { authClient } from "@/lib/auth-client";
import { fontFamily, useAppTheme } from "@/theme/tokens";

export default function AppLayout() {
  const { colors } = useAppTheme();
  const { data: session, isPending } = authClient.useSession();
  const {
    data: organization,
    error: organizationError,
    isPending: organizationPending,
    isRefetching: organizationRefetching,
    refetch: refetchOrganization,
  } = authClient.useActiveOrganization();
  const [organizationTimedOut, setOrganizationTimedOut] = useState(false);
  const [retryingOrganization, setRetryingOrganization] = useState(false);
  const { data: bootstrap } = useMobileBootstrap({ enabled: Boolean(session), poll: true });
  const unreadCount = bootstrap?.unreadNotifications ?? 0;
  const unreadBadge = unreadCount > 99 ? "99+" : unreadCount || undefined;
  useNativePushRegistration(organization?.id);

  useEffect(() => {
    if (organization || (!organizationPending && !organizationRefetching)) {
      setOrganizationTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setOrganizationTimedOut(true), 8_000);
    return () => clearTimeout(timer);
  }, [organization, organizationPending, organizationRefetching]);

  async function retryOrganization() {
    if (retryingOrganization) return;
    setRetryingOrganization(true);
    setOrganizationTimedOut(false);
    try {
      await refetchOrganization();
    } finally {
      setRetryingOrganization(false);
    }
  }

  if (isPending || ((organizationPending || organizationRefetching) && !organizationTimedOut)) return <LoadingView />;
  if (!session) return <Redirect href="/sign-in" />;
  if (!organization && (organizationTimedOut || organizationError)) {
    return <SessionRecoveryView error={organizationTimedOut ? "Workspace restore took too long. Check your connection and try again." : organizationError?.message} retrying={retryingOrganization} onRetry={() => void retryOrganization()} />;
  }
  if (!organization) return <Redirect href="/organizations" />;

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
      <Tabs.Screen name="operations" options={{ title: "Operate", tabBarIcon: ({ color, size }) => <SlidersHorizontal color={color} size={size} /> }} />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Inbox",
          tabBarBadge: unreadBadge,
          tabBarBadgeStyle: {
            backgroundColor: colors.amber,
            color: colors.black,
            fontFamily,
            fontSize: 11,
            fontWeight: "900",
          },
          tabBarIcon: ({ color, size }) => <Bell color={color} size={size} />,
        }}
      />
      <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: ({ color, size }) => <UserRound color={color} size={size} /> }} />
    </Tabs>
  );
}
