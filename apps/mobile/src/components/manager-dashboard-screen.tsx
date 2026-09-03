import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow, OperationsStat } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getMobileDashboard } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

export function ManagerDashboardScreen({ kind }: { kind: "pm" | "tm" }) {
  const styles = useStyles();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const query = useQuery({ queryKey: ["mobile-dashboard", kind, orgId], queryFn: () => getMobileDashboard(orgId!, kind), enabled: Boolean(orgId), refetchInterval: 5_000 });
  if (!orgId || query.isPending) return <LoadingView label={`Opening ${kind === "pm" ? "production" : "technical"} manager…`} />;
  const data = query.data;
  const confirmed = data?.assignments.find((assignment) => assignment.status === "confirmed")?.count ?? 0;
  const assigned = data?.assignments.reduce((sum, assignment) => sum + assignment.count, 0) ?? 0;
  const equipmentAttention = data?.equipment.filter((asset) => asset.status !== "operational").length ?? 0;
  const streamAttention = (data?.inputs.filter((input) => !["connected", "streaming"].includes(input.status)).length ?? 0) + (data?.destinations.filter((destination) => destination.enabled && !destination.connected).length ?? 0);
  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow={kind === "pm" ? "SHOW READINESS" : "SYSTEM READINESS"} title={kind === "pm" ? "Prod Manager" : "Tech Manager"} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.error ? <OperationsError message={query.error.message} /> : null}
      <OperationsPanel title={data?.show?.name || data?.show?.serviceDate || "No scheduled show"} detail={data?.show ? `${data.show.serviceDate} · ${data.show.status ?? "stopped"}` : "Schedule a show to populate readiness data."} />
      <View style={styles.stats}>
        <OperationsStat label="Rundown" value={`${data?.items.complete ?? 0}/${data?.items.total ?? 0}`} tone={data?.items.total && data.items.complete === data.items.total ? "good" : "warning"} />
        <OperationsStat label="Checklist" value={`${data?.checklist.complete ?? 0}/${data?.checklist.total ?? 0}`} tone={data?.checklist.total && data.checklist.complete === data.checklist.total ? "good" : "warning"} />
        <OperationsStat label="Open faults" value={data?.incidents.length ?? 0} tone={data?.incidents.length ? "danger" : "good"} />
      </View>
      {kind === "pm" ? (
        <>
          <OperationsPanel title="Crew plan" detail={`${confirmed} of ${assigned} assignments confirmed`}>
            <AppButton label="Open schedule" variant="secondary" onPress={() => router.push("/schedule")} />
            {data?.assignments.length ? data.assignments.map((assignment) => <OperationsRow key={assignment.status} title={assignment.status} status={`${assignment.count}`} />) : <OperationsEmpty>No crew assignments exist for this show.</OperationsEmpty>}
          </OperationsPanel>
          <OperationsPanel title="Planning gaps" detail="Fix missing durations and owners in the live rundown.">
            <OperationsRow title="Missing durations" status={`${data?.items.missingDuration ?? 0}`} />
            <OperationsRow title="Missing owners" status={`${data?.items.missingOwner ?? 0}`} />
            <AppButton label="Open live rundown" onPress={() => data?.show?.id ? router.push({ pathname: "/show/[showId]", params: { showId: data.show.id } }) : router.push("/(app)/shows")} />
          </OperationsPanel>
        </>
      ) : (
        <>
          <View style={styles.stats}><OperationsStat label="Gear attention" value={equipmentAttention} tone={equipmentAttention ? "danger" : "good"} /><OperationsStat label="Stream attention" value={streamAttention} tone={streamAttention ? "danger" : "good"} /><OperationsStat label="Devices" value={data?.devices.filter((device) => device.enabled).length ?? 0} /></View>
          <OperationsPanel title="Technical queue">
            {data?.incidents.length ? data.incidents.map((incident) => <OperationsRow key={incident.id} title={incident.description} detail={`${incident.category} · ${incident.assignedName || "Unassigned"}`} status={incident.severity} onPress={() => router.push("/incidents")} />) : <OperationsEmpty>No unresolved faults.</OperationsEmpty>}
            <AppButton label="Open incidents" variant="secondary" onPress={() => router.push("/incidents")} />
          </OperationsPanel>
          <OperationsPanel title="Systems">
            <AppButton label="Asset inventory" variant="secondary" onPress={() => router.push("/asset-inventory")} />
            <AppButton label="Stream health" variant="secondary" onPress={() => router.push("/stream")} />
            <AppButton label="Device control" variant="secondary" onPress={() => router.push("/devices")} />
            <AppButton label="Audio plan" variant="secondary" onPress={() => router.push("/audio")} />
          </OperationsPanel>
        </>
      )}
    </Page>
  );
}
const useStyles = createThemedStyles(() => StyleSheet.create({ stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 } }));
