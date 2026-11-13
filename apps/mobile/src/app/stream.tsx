import { useQuery } from "@tanstack/react-query";
import { Redirect, router } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow, OperationsStat } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import { getMobileStreaming, readMobileDestinationControl } from "@/lib/mobile-api";
import { runMobileOperation } from "@/lib/request-deadline";
import { authClient } from "@/lib/auth-client";
import { destinationStatusLabels } from "@/lib/destination-status";
import { createThemedStyles } from "@/theme/tokens";

export default function StreamScreen() {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending) return <LoadingView label="Opening stream health…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return <StreamWorkspace key={`${session.user.id}:${organization.id}`} orgId={organization.id} userId={session.user.id} />;
}
function StreamWorkspace(scope: { orgId: string; userId: string }) {
  const styles = useStyles(), foregroundInterval = useScreenPollingInterval(5_000);
  const pollingInterval = (query: { state: { status: string } }) => query.state.status === "error" ? false : foregroundInterval;
  const inputs = useQuery({ queryKey: ["mobile-streaming", scope.userId, scope.orgId], queryFn: ({ signal }) => getMobileStreaming(scope.orgId, signal), enabled: foregroundInterval !== false, retry: false, networkMode: "always", refetchInterval: pollingInterval });
  const outputs = useQuery({ queryKey: ["mobile-destination-control", scope.userId, scope.orgId], queryFn: ({ signal }) => runMobileOperation(async child => {
    const data = await readMobileDestinationControl(scope, child.signal);
    if (data.orgId !== scope.orgId || data.userId !== scope.userId) throw new Error("Destination status belongs to a different workspace or account.");
    return data;
  }, signal, 10_000), enabled: foregroundInterval !== false, retry: false, networkMode: "always", refetchInterval: pollingInterval });
  const active = inputs.data?.inputs.filter(input => input.status === "connected" || input.status === "streaming").length ?? 0;
  return <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="LIVE SIGNAL" title="Stream Health" onRefresh={() => { void inputs.refetch(); void outputs.refetch(); }}>
    {inputs.isPending ? <OperationsEmpty>Loading stream inputs…</OperationsEmpty> : null}
    {inputs.isError ? <><OperationsError message={inputs.data ? "Input health could not refresh. Last confirmed input values are shown." : "Input health could not load. Retry to check the live inputs."} /><AppButton label="Retry stream inputs" variant="secondary" loading={inputs.isFetching} onPress={() => void inputs.refetch()} /></> : null}
    {inputs.data ? <>
      <View style={styles.stats}><OperationsStat label="Inputs confirmed active" value={`${active}/${inputs.data.inputs.length}`} tone={inputs.isError ? "warning" : active ? "good" : "warning"} /></View>
      <OperationsPanel title="Live inputs" detail={inputs.isError ? "Last confirmed input state" : "Provider state refreshes every five seconds while this screen is open."}>
        {inputs.data.inputs.length ? inputs.data.inputs.map(input => <OperationsRow key={input.id} title={input.name} detail={input.error || `${input.srtUrl ? "RTMP + SRT" : "RTMP"} ingest · provider ${input.providerStatus ?? "pending"}`} status={input.status} />) : <OperationsEmpty>No live input is configured. Add one from the web streaming controls before the show.</OperationsEmpty>}
      </OperationsPanel>
    </> : null}
    {outputs.isPending ? <OperationsEmpty>Loading destination status…</OperationsEmpty> : null}
    {outputs.isError ? <><OperationsError message={outputs.data ? "Destination status could not refresh. Last confirmed values are shown." : "Destination status could not load. Retry to check distribution."} /><AppButton label="Retry destination status" variant="secondary" loading={outputs.isFetching} onPress={() => void outputs.refetch()} /></> : null}
    {outputs.data ? <OperationsPanel title="Distribution health" detail={outputs.isError ? "Last confirmed provider state" : "An enabled provider output does not prove that the encoder is sending a live input."}>
      {outputs.data.destinations.length ? outputs.data.destinations.map(destination => <View key={destination.id} style={styles.destination}>
        <Text style={styles.title}>{destination.name}</Text><Text style={styles.text}>{destination.selected ? "Selected for Go Live" : "Not selected"} · {destinationStatusLabels[destination.status]}</Text>
        {destination.error ? <OperationsError message={destination.error} /> : null}
      </View>) : <OperationsEmpty>No streaming destinations are configured.</OperationsEmpty>}
      {outputs.data.destinations.some(destination => destination.status === "unknown") ? <AppButton label="Retry provider status" variant="secondary" loading={outputs.isFetching} onPress={() => void outputs.refetch()} /> : null}
    </OperationsPanel> : null}
    <AppButton label="Manage destinations" variant="secondary" onPress={() => router.push("/multi-platform")} />
  </Page>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  destination: { gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft, paddingBottom: 12 },
  title: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "700" }, text: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
}));
