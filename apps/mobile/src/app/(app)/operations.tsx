import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import Cable from "lucide-react-native/icons/cable";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import MessageSquareText from "lucide-react-native/icons/message-square-text";
import ListChecks from "lucide-react-native/icons/list-checks";
import UserCheck from "lucide-react-native/icons/user-check";
import UserCog from "lucide-react-native/icons/user-cog";
import UserRound from "lucide-react-native/icons/user-round";
import UsersRound from "lucide-react-native/icons/users-round";
import { router } from "expo-router";
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
  const canChecklist = permissions.has("checklist:view") || permissions.has("checklist:access");
  const canCheckIn = permissions.has("checkin:access");
  const canManageMembers = permissions.has("settings:members");
  const canManageAccess = data?.accessAuthority?.canManage === true;

  return (
    <Page eyebrow="CONTROL SURFACES" title="Operations">
      <Text style={styles.intro}>Native tools available to your current role and on-duty access grants.</Text>
      <View style={styles.list}>
        <FeatureLink icon={CalendarClock} title="Schedule" description="Your assignments and call times. Schedule roles also see the full crew plan." onPress={() => router.push("/schedule")} />
        {canChat ? <FeatureLink icon={MessageSquareText} title="Production chat" description="The same live crew room used by web and desktop operators." badge="LIVE" onPress={() => router.push("/chat")} /> : null}
        {canChecklist ? <FeatureLink icon={ListChecks} title="Pre-show checklist" description="Prepare each department, generate checks from the rundown, and track completion live." onPress={() => router.push("/checklist")} /> : null}
        {canCheckIn ? <FeatureLink icon={UserCheck} title="Crew check-in" description="Find crew by member ID or roster and keep attendance synchronized for every operator." onPress={() => router.push("/checkin")} /> : null}
        {canManageMembers ? <FeatureLink icon={UserCog} title="Organization members" description="Invite sign-in users, assign roles, cancel invitations, or revoke workspace membership." onPress={() => router.push("/team-members")} /> : null}
        {canManageMembers ? <FeatureLink icon={UserRound} title="Crew roster" description="Create and maintain production identities, badges, roles, emails, and photos." onPress={() => router.push("/team-crew")} /> : null}
        {canManageAccess ? <FeatureLink icon={UsersRound} title="Team access" description="Grant or revoke weekly and ongoing operational capabilities." onPress={() => router.push("/team")} /> : null}
        {canIncidents ? <FeatureLink icon={AlertTriangle} title="Incidents" description="Report faults and follow ownership through resolution." onPress={() => router.push("/incidents")} /> : null}
        {canDevices ? <FeatureLink icon={Cable} title="Devices" description="Venue and Bridge-connected production equipment." onPress={() => router.push("/devices")} /> : null}
      </View>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  intro: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, marginTop: -12 },
  list: { gap: 11 },
}));
