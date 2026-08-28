import AlertTriangle from "lucide-react-native/icons/triangle-alert";
import Cable from "lucide-react-native/icons/cable";
import CalendarClock from "lucide-react-native/icons/calendar-clock";
import MessageSquareText from "lucide-react-native/icons/message-square-text";
import MonitorPlay from "lucide-react-native/icons/monitor-play";
import RadioTower from "lucide-react-native/icons/radio-tower";
import ListChecks from "lucide-react-native/icons/list-checks";
import UserCheck from "lucide-react-native/icons/user-check";
import UserCog from "lucide-react-native/icons/user-cog";
import UserRound from "lucide-react-native/icons/user-round";
import UsersRound from "lucide-react-native/icons/users-round";
import Clock4 from "lucide-react-native/icons/clock-4";
import ClipboardList from "lucide-react-native/icons/clipboard-list";
import Package from "lucide-react-native/icons/package";
import Radio from "lucide-react-native/icons/radio";
import Share2 from "lucide-react-native/icons/share-2";
import Captions from "lucide-react-native/icons/captions";
import FileChart from "lucide-react-native/icons/file-chart-column-increasing";
import Wrench from "lucide-react-native/icons/wrench";
import AudioLines from "lucide-react-native/icons/audio-lines";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { FeatureLink } from "@/components/feature-link";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { createThemedStyles } from "@/theme/tokens";

export default function OperationsScreen() {
  const styles = useStyles();
  const { data } = useMobileBootstrap();
  const permissions = new Set(data?.identity.permissions ?? []);
  const canChat = permissions.has("chat:access");
  const canIncidents = permissions.has("incidents:report") || permissions.has("incidents:access");
  const canDevices = permissions.has("devices:access");
  const canChecklist = permissions.has("checklist:view") || permissions.has("checklist:access");
  const canCheckIn = permissions.has("checkin:access");
  const canShowBoard = permissions.has("showboard:view");
  const canViewShow = permissions.has("show:view");
  const canManageMembers = permissions.has("settings:members");
  const canManageAccess = data?.accessAuthority?.canManage === true;
  const canTimecode = permissions.has("timecode:access");
  const canCueSheets = permissions.has("cuesheet:view") || permissions.has("cuesheet:edit") || permissions.has("cuesheet:add_notes");
  const canAssets = permissions.has("assets:view") || permissions.has("assets:manage");
  const canStream = permissions.has("stream_health:view") || permissions.has("stream_health:manage");
  const canMultiPlatform = permissions.has("streaming_suite:access") || permissions.has("stream_health:manage");
  const canLowerThirds = permissions.has("lowerthird:view") || permissions.has("lowerthird:trigger") || permissions.has("lowerthird:configure");
  const canProdManager = permissions.has("dashboard:pm");
  const canTechManager = permissions.has("dashboard:tm");
  const canReports = permissions.has("schedule:view");

  return (
    <Page eyebrow="CONTROL SURFACES" title="Operations" subtitle="Native tools available to your current role and on-duty access grants.">
      <View style={styles.list}>
        <FeatureLink icon={CalendarClock} title="Schedule" description="Your assignments and call times. Schedule roles also see the full crew plan." onPress={() => router.push("/schedule")} />
        {canViewShow ? <FeatureLink icon={RadioTower} title="Live Show" description="Follow the authoritative timer, current and next cues, active crew, chat, and rundown from one workspace." badge="LIVE" onPress={() => router.push("/live-show")} /> : null}
        {canTimecode ? <FeatureLink icon={Clock4} title="Timecode" description="Monitor and operate the shared SMPTE relay, source, format, and automation events." badge="LIVE" onPress={() => router.push("/timecode")} /> : null}
        {canChat ? <FeatureLink icon={MessageSquareText} title="Production chat" description="The same live crew room used by web and desktop operators." badge="LIVE" onPress={() => router.push("/chat")} /> : null}
        {canCueSheets ? <FeatureLink icon={ClipboardList} title="Cue sheets" description="Edit department columns and live instructions against the authoritative rundown." onPress={() => router.push("/cue-sheets")} /> : null}
        {canChecklist ? <FeatureLink icon={ListChecks} title="Pre-show checklist" description="Prepare each department, generate checks from the rundown, and track completion live." onPress={() => router.push("/checklist")} /> : null}
        {canCheckIn ? <FeatureLink icon={UserCheck} title="Crew check-in" description="Find crew by member ID or roster and keep attendance synchronized for every operator." onPress={() => router.push("/checkin")} /> : null}
        {canShowBoard ? <FeatureLink icon={MonitorPlay} title="Show Board" description="Live crew status, venue clock, and the public check-in QR for phones and tablets." badge="LIVE" onPress={() => router.push("/show-board")} /> : null}
        {canManageMembers ? <FeatureLink icon={UserCog} title="Organization members" description="Invite sign-in users, assign roles, cancel invitations, or revoke workspace membership." onPress={() => router.push("/team-members")} /> : null}
        {canManageMembers ? <FeatureLink icon={UserRound} title="Crew roster" description="Create and maintain production identities, badges, roles, emails, and photos." onPress={() => router.push("/team-crew")} /> : null}
        {canManageAccess ? <FeatureLink icon={UsersRound} title="Team access" description="Grant or revoke weekly and ongoing operational capabilities." onPress={() => router.push("/team")} /> : null}
        {canIncidents ? <FeatureLink icon={AlertTriangle} title="Incidents" description="Report faults and follow ownership through resolution." onPress={() => router.push("/incidents")} /> : null}
        {canAssets ? <FeatureLink icon={Package} title="Assets" description="Search, add, edit, and retire production equipment and metadata." onPress={() => router.push("/asset-inventory")} /> : null}
        {canStream ? <FeatureLink icon={Radio} title="Stream health" description="Watch live input and distribution state with five-second provider polling." badge="LIVE" onPress={() => router.push("/stream")} /> : null}
        {canMultiPlatform ? <FeatureLink icon={Share2} title="Multi-platform" description="Manage write-only RTMP credentials and connect or disconnect distribution outputs." onPress={() => router.push("/multi-platform")} /> : null}
        {canLowerThirds ? <FeatureLink icon={Captions} title="Lower thirds" description="Create, edit, take, stack, and clear cloud graphics on air." badge="LIVE" onPress={() => router.push("/lower-thirds")} /> : null}
        {canProdManager ? <FeatureLink icon={ClipboardList} title="Prod Manager" description="Crew, rundown, checklist, and planning readiness in one operational dashboard." onPress={() => router.push("/prod-manager")} /> : null}
        {canReports ? <FeatureLink icon={FileChart} title="Reports" description="Review show outcomes and export native PDF handoff reports." onPress={() => router.push("/reports")} /> : null}
        {canTechManager ? <FeatureLink icon={Wrench} title="Tech Manager" description="Fault, equipment, stream, device, and systems readiness with live drill-downs." onPress={() => router.push("/tech-manager")} /> : null}
        {canTechManager ? <FeatureLink icon={AudioLines} title="Audio" description="Build and operate the show input list, patch, gain, phantom power, and mute plan." onPress={() => router.push("/audio")} /> : null}
        {canDevices ? <FeatureLink icon={Cable} title="Devices" description="Venue and Bridge-connected production equipment." onPress={() => router.push("/devices")} /> : null}
      </View>
    </Page>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  list: { gap: 11 },
}));
