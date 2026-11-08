import { ShowCreationSheet } from "@/components/show-creation-sheet";
import { useShowCreationDrafts } from "@/hooks/use-show-creation";
import { authClient } from "@/lib/auth-client";
import { useState } from "react";
import Plus from "lucide-react-native/icons/plus";
import RadioTower from "lucide-react-native/icons/radio-tower";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Redirect, router } from "expo-router";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { FeatureLink } from "@/components/feature-link";
import { ShowCard } from "@/components/show-card";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getServiceDateForTimeZone } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function ShowsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { organization, data, isPending, error, refetch } = useMobileBootstrap();
  const [creating, setCreating] = useState(false);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const timeZone = data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canCreate = Boolean(data?.identity.permissions.includes("schedule:manage"));
  const canViewLiveShow = Boolean(data?.identity.permissions.includes("show:view"));
  const { data: session } = authClient.useSession();
  const scope = { orgId: organization?.id ?? "", userId: session?.user.id ?? "" };
  const drafts = useShowCreationDrafts(scope);
  if (!organization) return <Redirect href="/organizations" />;

  async function refreshShows() {
    setManualRefreshing(true);
    try {
      await refetch();
    } finally {
      setManualRefreshing(false);
    }
  }

  return (
    <Page
      eyebrow="RUNDOWNS"
      title="Shows"
      subtitle={`Upcoming and active shows for ${organization.name}.`}
      scroll={false}
      action={canCreate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create show"
          onPress={() => setCreating(true)}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <Plus color={colors.black} size={21} />
        </Pressable>
      ) : null}
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={data?.shows ?? []}
        initialNumToRender={10}
        keyExtractor={(show) => show.id}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {drafts[0] ? <AppButton variant="secondary" label={`Resume show: ${drafts[0].name || "Untitled show"} (${drafts[0].serviceDate})`} onPress={() => setCreating(true)} /> : null}
            {canViewLiveShow ? (
              <FeatureLink icon={RadioTower} title="Open Live Show" description="One synchronized workspace for the live timer, cues, crew, chat, and full rundown." badge="LIVE" onPress={() => router.push("/live-show")} />
            ) : null}
            {isPending ? (
              <ActivityIndicator color={colors.amberText} size="large" />
            ) : null}
            {error ? (
              <Text onPress={() => refetch()} style={styles.error}>{error.message}{"\n"}<Text style={styles.retry}>Tap to retry</Text></Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={data && !isPending ? (
          <Text style={styles.empty}>
            {canCreate ? "No upcoming shows. Tap + to schedule the first one." : "There are no upcoming shows in this workspace."}
          </Text>
        ) : null}
        maxToRenderPerBatch={10}
        onRefresh={() => void refreshShows()}
        refreshing={manualRefreshing}
        renderItem={({ item: show }) => (
          <ShowCard show={show} timeZone={timeZone} onPress={() => router.push({ pathname: "/show/[showId]", params: { showId: show.id } })} />
        )}
        windowSize={7}
      />
      {creating && session ? <ShowCreationSheet key={`${scope.userId}:${scope.orgId}`} {...scope}
        initial={drafts[0] ?? { serviceDate: getServiceDateForTimeZone(timeZone), timeZone, name: "", startTime: "", callTime: "", location: "", source: { kind: "blank" } }}
        onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  addButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  list: { gap: 12, paddingBottom: spacing.large },
  listHeader: { gap: spacing.medium, marginBottom: 2 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 21 },
  retry: { color: colors.amberText, fontWeight: "700" },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
}));
