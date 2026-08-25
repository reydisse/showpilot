import { useEffect } from "react";
import { Building2, Check, ChevronRight } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
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

  useEffect(() => {
    if (organizations?.length === 1 && !activeOrganization) {
      void chooseOrganization(organizations[0].id);
    }
  }, [activeOrganization, organizations]);

  async function chooseOrganization(organizationId: string) {
    const result = await authClient.organization.setActive({ organizationId });
    if (!result.error) {
      await Haptics.selectionAsync();
      router.replace("/(app)");
    }
  }

  if (sessionPending || isPending) return <LoadingView label="Loading your workspaces…" />;
  if (!session) return <Redirect href="/sign-in" />;

  return (
    <Page eyebrow="WORKSPACE" title="Choose your team">
      <Text style={styles.intro}>Your shows, crew, and permissions stay isolated inside each organization.</Text>
      <View style={styles.list}>
        {organizations?.map((organization) => {
          const active = organization.id === activeOrganization?.id;
          return (
            <Pressable key={organization.id} onPress={() => chooseOrganization(organization.id)} style={({ pressed }) => [styles.card, active && styles.cardActive, pressed && styles.pressed]}>
              <View style={[styles.icon, active && styles.iconActive]}><Building2 size={22} color={active ? colors.black : colors.amberText} /></View>
              <View style={styles.cardCopy}>
                <Text style={styles.name}>{organization.name}</Text>
                <Text style={styles.slug}>{organization.slug}</Text>
              </View>
              {active ? <Check size={20} color={colors.amberText} /> : <ChevronRight size={20} color={colors.textFaint} />}
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
  list: { gap: 12 },
  card: { minHeight: 76, flexDirection: "row", alignItems: "center", gap: 14, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  cardActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  pressed: { opacity: 0.75 },
  icon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.amberSoft },
  iconActive: { backgroundColor: colors.amber },
  cardCopy: { flex: 1, gap: 4 },
  name: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  slug: { color: colors.textFaint, fontFamily, fontSize: 12 },
  empty: { gap: 8, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  emptyTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "700" },
  emptyCopy: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21 },
}));
