import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Bell from "lucide-react-native/icons/bell";
import CalendarDays from "lucide-react-native/icons/calendar-days";
import Gauge from "lucide-react-native/icons/gauge";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import MessagesSquare from "lucide-react-native/icons/messages-square";
import { Redirect, Tabs } from "expo-router";
import { LoadingView } from "@/components/loading-view";
import { SessionRecoveryView } from "@/components/session-recovery-view";
import { useNativePushRegistration } from "@/hooks/use-native-push-registration";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import { authClient } from "@/lib/auth-client";
import { getMobileChatUnread } from "@/lib/mobile-api";
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
  const pollingInterval = useScreenPollingInterval(30_000);
  const { data: chatUnread } = useQuery({
    queryKey: ["mobile-chat-unread", session?.user.id, organization?.id],
    queryFn: () => getMobileChatUnread(organization!.id),
    enabled: Boolean(session && organization && bootstrap?.identity.permissions.includes("chat:access")),
    refetchInterval: pollingInterval,
  });
  const chatBadge = chatUnread?.unread ? (chatUnread.unread > 99 ? "99+" : chatUnread.unread) : undefined;
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

  // Background refreshes retain the mounted tab, scroll position and drafts.
  if (isPending || (!organization && organizationPending && !organizationTimedOut)) return <LoadingView />;
  if (!session) return <Redirect href="/sign-in" />;
  if (!organization && (organizationTimedOut || organizationError)) {
    return <SessionRecoveryView error={organizationTimedOut ? "Workspace restore took too long. Check your connection and try again." : organizationError?.message} retrying={retryingOrganization} onRetry={() => void retryOrganization()} />;
  }
  if (!organization) return <Redirect href="/organizations" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
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
      <Tabs.Screen name="chat" options={{ title: "Chats", tabBarBadge: chatBadge, tabBarBadgeStyle: { backgroundColor: colors.amber, color: colors.black }, tabBarIcon: ({ color, size }) => <MessagesSquare color={color} size={size} /> }} />
      <Tabs.Screen name="profile" options={{ href: null }} />
    </Tabs>
  );
}
