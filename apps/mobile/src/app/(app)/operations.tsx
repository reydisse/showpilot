import { AlertTriangle, CalendarClock, MessageSquareText, Network } from "lucide-react-native";
import { router, type Href } from "expo-router";
import { Text, StyleSheet, View } from "react-native";
import { FeatureLink } from "@/components/feature-link";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createThemedStyles, fontFamily } from "@/theme/tokens";

export default function OperationsScreen() {
  const styles = useStyles();
  const { data } = useMobileBootstrap();
  const permissions = new Set(data?.identity.permissions ?? []);
  const canChat = permissions.has("chat:access");
  const canIncidents = permissions.has("incidents:report") || permissions.has("incidents:access");
  const canDevices = permissions.has("devices:access");

  return (
    <Page eyebrow="CONTROL SURFACES" title="Operations">
      <Text style={styles.intro}>Native tools available to your current role and on-duty access grants.</Text>
      <View style={styles.list}>
        <FeatureLink icon={CalendarClock} title="Schedule" description="Your assignments and call times. Schedule roles also see the full crew plan." onPress={() => router.push("/schedule" as Href)} />
        {canChat ? <FeatureLink icon={MessageSquareText} title="Production chat" description="The same live crew room used by web and desktop operators." badge="LIVE" onPress={() => router.push("/chat" as Href)} /> : null}
        {canIncidents ? <FeatureLink icon={AlertTriangle} title="Incidents" description="Report faults and follow ownership through resolution." onPress={() => router.push("/incidents" as Href)} /> : null}
        {canDevices ? <FeatureLink icon={Network} title="Devices" description="Venue and Bridge-connected production equipment." onPress={() => router.push("/devices" as Href)} /> : null}
      </View>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  intro: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, marginTop: -12 },
  list: { gap: 11 },
}));
