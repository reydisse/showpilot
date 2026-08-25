import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, Check, ChevronRight } from "lucide-react-native";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import * as Haptics from "expo-haptics";
import { LoadingView } from "@/components/loading-view";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function OrganizationsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: organizations, isPending } = authClient.useListOrganizations();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const [choosingId, setChoosingId] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState("");
  const autoSelectionAttempted = useRef(false);

  const chooseOrganization = useCallback(async (organizationId: string) => {
    if (choosingId) return;
    setSelectionError("");
    setChoosingId(organizationId);
    try {
      const result = await authClient.organization.setActive({ organizationId });
      if (result.error) throw new Error(result.error.message || "The workspace could not be opened.");
      await Haptics.selectionAsync();
      router.replace("/(app)");
    } catch (caught) {
      setSelectionError(caught instanceof Error ? caught.message : "ShowPilot could not be reached. Check your connection and try again.");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setChoosingId(null);
    }
  }, [choosingId]);

  useEffect(() => {
    if (organizations?.length === 1 && !activeOrganization && !autoSelectionAttempted.current) {
      autoSelectionAttempted.current = true;
      void chooseOrganization(organizations[0].id);
    }
  }, [activeOrganization, chooseOrganization, organizations]);

  if (sessionPending || isPending) return <LoadingView label="Loading your workspaces…" />;
  if (!session) return <Redirect href="/sign-in" />;

  return (
    <Page eyebrow="WORKSPACE" title="Choose your team">
      <Text style={styles.intro}>Your shows, crew, and permissions stay isolated inside each organization.</Text>
      {selectionError ? <Text accessibilityRole="alert" style={styles.error}>{selectionError}</Text> : null}
      <View style={styles.list}>
        {organizations?.map((organization) => {
          const active = organization.id === activeOrganization?.id;
          const choosing = choosingId === organization.id;
          return (
            <Pressable accessibilityRole="button" accessibilityState={{ busy: choosing, disabled: Boolean(choosingId) }} disabled={Boolean(choosingId)} key={organization.id} onPress={() => chooseOrganization(organization.id)} style={({ pressed }) => [styles.card, active && styles.cardActive, pressed && styles.pressed, choosingId && !choosing && styles.disabled]}>
              <View style={[styles.icon, active && styles.iconActive]}><Building2 size={22} color={active ? colors.black : colors.amberText} /></View>
              <View style={styles.cardCopy}>
                <Text style={styles.name}>{organization.name}</Text>
                <Text style={styles.slug}>{organization.slug}</Text>
              </View>
              {choosing ? <ActivityIndicator color={colors.amberText} /> : active ? <Check size={20} color={colors.amberText} /> : <ChevronRight size={20} color={colors.textFaint} />}
            </Pressable>
          );
        })}
      </View>
      {!organizations?.length ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No organization yet</Text>
          <Text style={styles.emptyCopy}>Create your first organization on showpilot.tech. It will appear here immediately.</Text>
        </View>
      ) : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  intro: { color: colors.textMuted, fontFamily, fontSize: 15, lineHeight: 22, marginTop: -12 },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 19, borderRadius: radii.small, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft, padding: 12 },
  list: { gap: 12 },
  card: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 14, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  cardActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
  icon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.amberSoft },
  iconActive: { backgroundColor: colors.amber },
  cardCopy: { flex: 1, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  slug: { color: colors.textFaint, fontFamily, fontSize: 12 },
  empty: { gap: 8, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  emptyCopy: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
}));
