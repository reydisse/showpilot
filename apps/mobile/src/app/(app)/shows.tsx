import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Redirect, router, type Href } from "expo-router";
import { Page } from "@/components/page";
import { ShowCard } from "@/components/show-card";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export default function ShowsScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { organization, data, isPending, error, refetch } = useMobileBootstrap();
  if (!organization) return <Redirect href="/organizations" />;

  return (
    <Page eyebrow="RUNDOWNS" title="Shows">
      <Text style={styles.intro}>Upcoming and active shows for {organization.name}.</Text>
      {isPending ? <ActivityIndicator color={colors.amberText} size="large" /> : null}
      {error ? <Text onPress={() => refetch()} style={styles.error}>{error.message}{"\n"}<Text style={styles.retry}>Tap to retry</Text></Text> : null}
      <View style={styles.list}>
        {data?.shows.map((show) => (
          <ShowCard key={show.id} show={show} timeZone={data.timeZone} onPress={() => router.push({ pathname: "/show/[showId]", params: { showId: show.id } } as unknown as Href)} />
        ))}
      </View>
      {data && data.shows.length === 0 ? <Text style={styles.empty}>There are no upcoming shows in this workspace.</Text> : null}
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  intro: { color: colors.textMuted, fontFamily, fontSize: 15, lineHeight: 22, marginTop: -12 },
  list: { gap: 12 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  error: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 21 },
  retry: { color: colors.amberText, fontWeight: "700" },
}));
