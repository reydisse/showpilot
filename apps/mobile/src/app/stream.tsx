import { useQuery } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel, OperationsRow, OperationsStat } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { getMobileStreaming } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

export default function StreamScreen() {
  const styles = useStyles();
  const { organization } = useMobileBootstrap();
  const orgId = organization?.id;
  const query = useQuery({ queryKey: ["mobile-streaming", orgId], queryFn: () => getMobileStreaming(orgId!), enabled: Boolean(orgId), refetchInterval: 5_000 });
  if (!orgId || query.isPending) return <LoadingView label="Opening stream health…" />;
  const inputs = query.data?.inputs ?? [];
  const destinations = query.data?.destinations ?? [];
  const active = inputs.filter((input) => input.status === "connected" || input.status === "streaming").length;
  const connected = destinations.filter((destination) => destination.connected).length;
  return (
    <Page eyebrow="LIVE SIGNAL" title="Stream Health" refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      {query.error ? <OperationsError message={query.error.message} /> : null}
      <View style={styles.stats}><OperationsStat label="Inputs active" value={`${active}/${inputs.length}`} tone={active ? "good" : "warning"} /><OperationsStat label="Outputs wired" value={`${connected}/${destinations.length}`} tone={connected === destinations.length && destinations.length ? "good" : "warning"} /></View>
      <OperationsPanel title="Live inputs" detail="Cloudflare provider state refreshes every five seconds.">
        {inputs.length ? inputs.map((input) => <OperationsRow key={input.id} title={input.name} detail={input.error || `${input.srtUrl ? "RTMP + SRT" : "RTMP"} ingest · provider ${input.providerStatus ?? "pending"}`} status={input.status} />) : <OperationsEmpty>No live input is configured. Add one from the web integration settings before the show.</OperationsEmpty>}
      </OperationsPanel>
      <OperationsPanel title="Distribution health">
        {destinations.length ? destinations.map((destination) => <OperationsRow key={destination.id} title={destination.name} detail={destination.platform} status={!destination.enabled ? "Disabled" : destination.connected ? "Wired" : "Waiting"} />) : <OperationsEmpty>No streaming destinations are configured.</OperationsEmpty>}
      </OperationsPanel>
    </Page>
  );
}
const useStyles = createThemedStyles(() => StyleSheet.create({ stats: { flexDirection: "row", flexWrap: "wrap", gap: 10 } }));
