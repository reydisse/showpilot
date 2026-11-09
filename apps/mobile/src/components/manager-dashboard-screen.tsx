import { useQuery } from "@tanstack/react-query";
import { Redirect, router } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow, OperationsStat } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { authClient } from "@/lib/auth-client";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import { getMobileDashboard } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

export function ManagerDashboardScreen({ kind }: { kind: "pm" | "tm" }) {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending) return <LoadingView label="Opening manager dashboard…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return <ManagerWorkspace key={`${session.user.id}:${organization.id}:${kind}`} orgId={organization.id} userId={session.user.id} kind={kind} />;
}
function ManagerWorkspace({ orgId, userId, kind }: { orgId: string; userId: string; kind: "pm" | "tm" }) {
  const styles = useStyles();
  const foregroundInterval = useScreenPollingInterval(5_000);
  const pollingInterval = (query: { state: { status: string } }) => query.state.status === "error" ? false : foregroundInterval;
  const query = useQuery({ queryKey: ["mobile-dashboard", userId, kind, orgId], queryFn: ({ signal }) => getMobileDashboard(orgId, kind, { signal }), enabled: foregroundInterval !== false, retry: false, networkMode: "always", refetchInterval: pollingInterval });
  const data = query.data;
  const confirmed = data?.assignments.find((assignment) => assignment.status === "confirmed")?.count ?? 0;
  const assigned = data?.assignments.reduce((sum, assignment) => sum + assignment.count, 0) ?? 0;
  const equipmentAttention = data?.totals.equipmentAttention ?? 0;
  const streamAttention = (data?.inputs.filter((input) => !["connected", "streaming"].includes(input.status)).length ?? 0) + (data?.destinations.filter((destination) => destination.enabled && !destination.connected).length ?? 0);
  return (
    <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow={kind === "pm" ? "SHOW READINESS" : "SYSTEM READINESS"} title={kind === "pm" ? "Prod Manager" : "Tech Manager"} subtitle={kind === "pm" ? "Crew assignments, rundown preparation and checklist readiness." : "Incidents, equipment and system readiness. Open Stream health for current provider status."} refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.isPending ? <OperationsEmpty>Loading manager dashboard…</OperationsEmpty> : null}
      {query.isError ? <><OperationsError message={data ? "Dashboard could not refresh. Last confirmed values are shown." : "Dashboard could not load. Retry to check readiness."} /><AppButton label="Retry dashboard" variant="secondary" loading={query.isFetching} onPress={() => void query.refetch()} /></> : null}
      {data ? <>
      <OperationsPanel title={data?.show?.name || data?.show?.serviceDate || "No scheduled show"} detail={data?.show ? `${data.show.serviceDate} · ${data.show.status ?? "stopped"}` : "Schedule a show to populate readiness data."} />
      <View style={styles.stats}>
        <OperationsStat label="Rundown" value={`${data?.items.complete ?? 0}/${data?.items.total ?? 0}`} tone={data?.items.total && data.items.complete === data.items.total ? "good" : "warning"} />
        <OperationsStat label="Checklist" value={`${data?.checklist.complete ?? 0}/${data?.checklist.total ?? 0}`} tone={data?.checklist.total && data.checklist.complete === data.checklist.total ? "good" : "warning"} />
        <OperationsStat label="Open incidents" value={data?.totals.openIncidents ?? 0} tone={data?.totals.openIncidents ? "danger" : "good"} />
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
          <View style={styles.stats}><OperationsStat label="Gear attention" value={equipmentAttention} tone={equipmentAttention ? "danger" : "good"} /><OperationsStat label="Stream setup attention" value={streamAttention} tone={streamAttention ? "danger" : "good"} /><OperationsStat label="Devices" value={data?.devices.filter((device) => device.enabled).length ?? 0} /></View>
          <OperationsPanel title="Technical queue" detail={data?.totals.openIncidents && data.totals.openIncidents > data.incidents.length ? `Showing ${data.incidents.length} of ${data.totals.openIncidents} open incidents` : undefined}>
            {data?.incidents.length ? data.incidents.map((incident) => <OperationsRow key={incident.id} title={incident.description} detail={`${incident.category} · ${incident.assignedName || "Unassigned"}`} status={incident.severity} onPress={() => router.push("/incidents")} />) : <OperationsEmpty>No unresolved incidents.</OperationsEmpty>}
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
      </> : null}
    </Page>
  );
}
const useStyles = createThemedStyles(() => StyleSheet.create({ stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 } }));
