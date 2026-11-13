import { useEffect, useState } from "react";
import { Redirect, router } from "expo-router";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import { useDestinationControl, type DestinationReview } from "@/hooks/use-destination-control";
import { authClient } from "@/lib/auth-client";
import { readMobileDestinationControl, writeMobileDestinationControl } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";
import { destinationStatusLabels } from "@/lib/destination-status";
export default function MultiPlatformScreen() {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending) return <LoadingView label="Opening destinations…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return <DestinationWorkspace key={`${session.user.id}:${organization.id}`} orgId={organization.id} userId={session.user.id} />;
}
function DestinationWorkspace(scope: { orgId: string; userId: string }) {
  const styles = useStyles(), pollingInterval = useScreenPollingInterval(5_000);
  const control = useDestinationControl(scope, { enabled: pollingInterval !== false, pollingInterval, read: readMobileDestinationControl, send: writeMobileDestinationControl });
  const { state, draft, attempt } = control, data = state.data;
  const [review, setReview] = useState<DestinationReview | "discard" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (pollingInterval === false) setReview(null); }, [pollingInterval]);
  const changed = review !== null && review !== "discard" && !control.matches(review);
  const retryable = attempt?.kind === "failed" || (attempt?.kind === "confirmed" && attempt.result.outcome === "unconfirmed");
  const recoveryReady = attempt?.kind === "failed" || (attempt?.kind === "confirmed" && attempt.refresh === "done");
  return <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="STREAM DESTINATIONS" title="Multi-Platform" onRefresh={() => void state.refetch()}>
    <Text style={styles.text}>Select destinations for the next Go Live from the web streaming controls. Selecting one does not start a broadcast. Disconnecting a destination stops forwarding to it; your encoder keeps running.</Text>
    {state.isPending ? <OperationsEmpty>Loading destinations…</OperationsEmpty> : null}
    {state.isError ? <><OperationsError message={data ? "Destinations could not refresh. Last confirmed values are shown; changes are paused." : "Destinations could not load. Retry to check their configuration and provider status."} /><AppButton label="Retry destinations" variant="secondary" loading={state.isFetching} onPress={() => void state.refetch()} /></> : null}
    {error ? <OperationsError message={error} /> : null}
    {attempt ? <OperationsPanel title="Destination change" detail={attempt.label}>
      {attempt.kind === "pending" ? <Text style={styles.text}>Waiting for confirmation…</Text> : retryable ? <>
        <OperationsError message={attempt.kind === "failed" ? attempt.message : attempt.kind === "confirmed" ? attempt.result.message ?? "This destination change is still unconfirmed." : "Waiting for confirmation…"} />
        <AppButton label="Retry original request" disabled={!recoveryReady} onPress={control.retry} />
        <AppButton label="Review current result" variant="secondary" disabled={!recoveryReady} onPress={control.review} />
        <Text style={styles.detail}>Review checks the original result and cancels an unsent request. An admitted provider command stays unconfirmed until it is reconciled.</Text>
      </> : attempt.kind === "confirmed" ? <Text style={styles.text}>{attempt.result.outcome === "applied" ? "Original change confirmed. Current destinations are shown below." : attempt.result.outcome === "conflict" ? "The destination changed before this request arrived. Review the current values before trying again." : attempt.result.outcome === "expired" ? "The request expired before it was admitted. Review the current destination before sending a new change." : attempt.result.outcome === "superseded" ? "A newer output command replaced this request. Review the current provider status before continuing." : "The request was cancelled before it was admitted. Your draft is retained."}</Text> : null}
      {attempt.kind === "confirmed" ? attempt.refresh === "done" ? !retryable ? <AppButton label="Dismiss result" variant="secondary" onPress={control.dismiss} /> : null : attempt.refresh === "pending" ? <Text style={styles.detail}>Refreshing destinations…</Text> : <><OperationsError message={attempt.message ?? "Refresh current destinations before continuing."} /><AppButton label="Retry destination refresh" onPress={control.refresh} /></> : null}
    </OperationsPanel> : null}
    {draft ? <OperationsPanel title={draft.base ? "Edit destination" : "Add destination"} detail="Stream keys stay hidden. This draft stays in the current app session when you leave the screen.">
      <AppField label="Name" maxLength={200} editable={control.settled} value={draft.fields.name} onChangeText={name => control.change({ ...draft.fields, name })} />
      <AppField label="Platform" maxLength={50} editable={control.settled} value={draft.fields.platform} onChangeText={platform => control.change({ ...draft.fields, platform: platform.toLowerCase() })} placeholder="youtube, facebook, twitch, custom" />
      <AppField label="RTMP URL" maxLength={500} editable={control.settled} value={draft.fields.rtmpUrl} onChangeText={rtmpUrl => control.change({ ...draft.fields, rtmpUrl })} autoCapitalize="none" autoCorrect={false} />
      <AppField label={draft.base ? "New stream key (blank keeps current)" : "Stream key"} maxLength={500} editable={control.settled} value={draft.fields.streamKey} onChangeText={streamKey => control.change({ ...draft.fields, streamKey })} secureTextEntry autoCorrect={false} />
      {control.draftStale ? <><OperationsError message={control.draftCurrent ? "This destination changed. Your draft is retained. Review the current saved values before replacing them." : "This destination was removed. Your draft is retained and will not recreate it."} />{control.draftCurrent ? <><Text style={styles.text}>Current: {control.draftCurrent.name} · {control.draftCurrent.platform} · {control.draftCurrent.rtmpUrl}</Text><AppButton label="Use current revision" variant="secondary" disabled={!control.canStart} onPress={control.rebase} /></> : null}</> : null}
      <Text style={styles.detail}>Disconnect the destination before changing its RTMP URL or stream key.</Text>
      <AppButton label="Save destination" disabled={!control.canStart || control.draftStale || !draft.fields.name.trim() || !draft.fields.platform.trim() || !/^rtmps?:\/\//i.test(draft.fields.rtmpUrl.trim()) || (!draft.base && !draft.fields.streamKey.trim())} onPress={() => {
        const next = control.prepareSave();
        if (!next || !control.confirm(next)) setError("Check the destination fields and review its current revision before saving."); else setError("");
      }} />
      <AppButton label="Discard draft" variant="secondary" disabled={!control.settled} onPress={() => setReview("discard")} />
      {control.draftCurrent ? <AppButton label="Delete destination" variant="danger" disabled={!control.canStart} onPress={() => { if (control.draftCurrent) setReview(control.prepare("delete", control.draftCurrent)); }} /> : null}
    </OperationsPanel> : data?.canManage ? <AppButton label="Add destination" disabled={!control.canStart} onPress={() => control.edit()} /> : null}
    {data ? <OperationsPanel title="Destinations" detail={state.isError ? "Last confirmed configuration and provider status" : "Selection and provider status are shown separately."}>
      {data.destinations.length ? data.destinations.map(destination => <View key={destination.id} style={styles.destination}>
        <Text style={styles.title}>{destination.name}</Text><Text style={styles.detail}>{destination.platform} · {destination.hasStreamKey ? "Key stored" : "Key missing"}</Text>
        <Text style={styles.text}>{destination.selected ? "Selected for Go Live" : "Not selected"}</Text>
        <Text style={styles.detail}>{destinationStatusLabels[destination.status]}{state.isError ? " · last confirmed" : ""}</Text>
        {destination.error ? <OperationsError message={destination.error} /> : null}
        {destination.status === "unknown" ? <AppButton label={`Retry status for ${destination.name}`} variant="secondary" loading={state.isFetching} onPress={() => void state.refetch()} /> : null}
        {data.canManage ? <>
          <AppButton label={`Edit ${destination.name}`} variant="secondary" disabled={!control.canStart || !!draft} onPress={() => control.edit(destination)} />
          {destination.selected || destination.status !== "none" ? <AppButton label={`Disconnect ${destination.name}`} variant="danger" disabled={!control.canStart} onPress={() => setReview(control.prepare("disable", destination))} /> : <AppButton label={`Select ${destination.name}`} disabled={!control.canStart} onPress={() => { const next = control.prepare("select", destination); if (next) control.confirm(next); }} />}
        </> : null}
      </View>) : <OperationsEmpty>No streaming destinations are configured.</OperationsEmpty>}
    </OperationsPanel> : null}
    <AppButton label="Open Stream health" variant="secondary" onPress={() => router.push("/stream")} />
    {review ? <Modal visible transparent animationType="none" onRequestClose={() => setReview(null)}><View style={styles.backdrop}><ScrollView style={styles.modal}><View style={styles.modalContent}>
      <Text accessibilityRole="header" style={styles.title}>{review === "discard" ? "Discard this draft?" : review.operation.kind === "delete" ? "Delete this destination?" : "Disconnect this destination?"}</Text>
      <Text style={styles.text}>{review === "discard" ? "This removes your unsaved destination fields and stream key from this app session." : review.operation.kind === "delete" ? `Disconnect and permanently remove “${review.label}”? Your encoder keeps running.` : `Stop forwarding to “${review.label}” and remove it from the next Go Live selection? Other destinations and your encoder keep running.`}</Text>
      {changed ? <OperationsError message="The destination or permissions changed while this confirmation was open. Keep the destination, review the latest state, and try again." /> : null}
      <AppButton label={review === "discard" ? "Keep draft" : "Keep destination"} variant="secondary" onPress={() => setReview(null)} />
      <AppButton label={review === "discard" ? "Confirm discard" : "Confirm change"} variant="danger" disabled={changed || (review === "discard" && !control.settled)} onPress={() => {
        if (review === "discard") control.discard(); else if (!control.confirm(review)) return;
        setReview(null); setError("");
      }} />
    </View></ScrollView></View></Modal> : null}
  </Page>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  text: { color: colors.text, fontSize: 14, lineHeight: 20 }, title: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "700" }, detail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  destination: { gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft, paddingBottom: 12 },
  backdrop: { flex: 1, backgroundColor: "#00000088", justifyContent: "center", padding: 16 },
  modal: { flexGrow: 0, maxHeight: "100%", width: "100%", maxWidth: 560, alignSelf: "center", backgroundColor: colors.panel, borderRadius: 14 }, modalContent: { padding: 16, gap: 12 },
}));
