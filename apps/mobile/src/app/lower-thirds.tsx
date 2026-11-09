import { useEffect, useState } from "react";
import { Redirect } from "expo-router";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { LoadingView } from "@/components/loading-view";
import { OperationsEmpty, OperationsError, OperationsPanel } from "@/components/operations-ui";
import { Page } from "@/components/page";
import { useScreenPollingInterval } from "@/hooks/use-screen-polling";
import { useGraphicControl, type GraphicReview } from "@/hooks/use-graphic-control";
import { authClient } from "@/lib/auth-client";
import { readMobileGraphicControl, writeMobileGraphicControl } from "@/lib/mobile-api";
import { createThemedStyles } from "@/theme/tokens";

export default function LowerThirdsScreen() {
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  if (organizationPending || sessionPending) return <LoadingView label="Opening lower thirds…" />;
  if (!organization || !session) return <Redirect href="/organizations" />;
  return <GraphicsWorkspace key={`${session.user.id}:${organization.id}`} orgId={organization.id} userId={session.user.id} />;
}
function GraphicsWorkspace(scope: { orgId: string; userId: string }) {
  const styles = useStyles();
  const pollingInterval = useScreenPollingInterval(2_000);
  const control = useGraphicControl(scope, { enabled: pollingInterval !== false, pollingInterval, read: readMobileGraphicControl, send: writeMobileGraphicControl });
  const { state, draft, attempt } = control;
  const data = state.data;
  const [review, setReview] = useState<GraphicReview | "discard" | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (pollingInterval === false) setReview(null); }, [pollingInterval]);
  const save = () => {
    const next = control.prepareSave();
    if (!next || !control.matches(next)) return setError("Review the current graphic and check its name and title before saving.");
    setError("");
    if (next.operation.kind === "update" && data?.activeIds.includes(next.operation.id)) setReview(next);
    else control.confirm(next);
  };
  const title = review === "discard" ? "Discard this draft?" : review?.operation.kind === "hide" ? "Take this graphic off air?"
    : review?.operation.kind === "show" ? "Take this graphic live?" : review?.operation.kind === "clear" ? "Clear program graphics?"
    : review?.operation.kind === "delete" ? "Delete this graphic?" : "Change this live graphic?";
  const changed = review !== null && review !== "discard" && !control.matches(review);
  return <Page backTo="/(app)/operations" backLabel="Back to operations" eyebrow="ON-AIR GRAPHICS" title="Lower Thirds" refreshing={state.isFetching} onRefresh={() => void state.refetch()}>
    {state.isPending ? <OperationsEmpty>Loading graphics…</OperationsEmpty> : null}
    {state.isError ? <><OperationsError message={data ? "Graphics could not refresh. Last confirmed state is shown; live controls are paused." : "Graphics could not load. Retry to check the library and live output."} /><AppButton label="Retry graphics" variant="secondary" loading={state.isFetching} onPress={() => void state.refetch()} /></> : null}
    {error ? <OperationsError message={error} /> : null}
    {data && !data.cloudEnabled ? <OperationsError message="Cloud graphics are disabled for this organization. Enable them in organization settings before going live." /> : null}
    {data?.unknownProgram ? <OperationsError message="Current program graphics could not be fully identified. Refresh, or review Clear program graphics to take them off air." /> : null}
    {attempt ? <OperationsPanel title="Graphics change" detail={attempt.label}>
      {attempt.kind === "pending" ? <Text style={styles.text}>Waiting for confirmation…</Text> : attempt.kind === "failed" ? <>
        <OperationsError message={attempt.message} /><AppButton label="Retry original request" onPress={control.retry} /><AppButton label="Review current graphics" variant="secondary" onPress={control.review} />
        <Text style={styles.detail}>Review checks the original result and cancels it if it has not arrived. Your draft stays here.</Text>
      </> : <>
        <Text style={styles.text}>{attempt.result.outcome === "applied" ? "Original change confirmed. Current graphics are shown below." : attempt.result.outcome === "conflict" ? "Graphics changed before this request arrived. Review the current state before trying again." : attempt.result.outcome === "expired" ? "The output request expired before it arrived. Review the current state before sending a new change." : "The request was cancelled before it arrived. Your draft is retained."}</Text>
        {attempt.refresh === "done" ? <AppButton label="Dismiss result" variant="secondary" onPress={control.dismiss} /> : attempt.refresh === "pending" ? <Text style={styles.detail}>Refreshing current graphics…</Text> : <><OperationsError message={attempt.message ?? "Refresh current graphics before continuing."} /><AppButton label="Retry graphics refresh" onPress={control.refresh} /></>}
      </>}
    </OperationsPanel> : null}
    {draft ? <OperationsPanel title={draft.base ? "Edit lower third" : "Create lower third"} detail="Your draft stays here when you leave this screen.">
      <AppField label="Template name" value={draft.content.name} editable={control.settled} onChangeText={name => control.change({ ...draft.content, name })} />
      <AppField label="Title" value={draft.content.title} editable={control.settled} onChangeText={title => control.change({ ...draft.content, title })} />
      <AppField label="Subtitle" value={draft.content.subtitle} editable={control.settled} onChangeText={subtitle => control.change({ ...draft.content, subtitle })} />
      {control.draftStale ? <><OperationsError message={control.draftCurrent ? "This graphic changed. Your draft is retained. Review the current saved text before choosing to replace it." : "This graphic is no longer in the library. Your draft is retained; it will not recreate a deleted graphic."} />{control.draftCurrent ? <><Text style={styles.text}>Current: {control.draftCurrent.name} · {control.draftCurrent.title} · {control.draftCurrent.subtitle}</Text><AppButton label="Use current revision" variant="secondary" disabled={!control.canStart} onPress={control.rebase} /></> : null}</> : null}
      <AppButton label="Save graphic" disabled={!control.canStart || !data?.canConfigure || control.draftStale || !draft.content.name.trim() || !draft.content.title.trim()} onPress={save} />
      <AppButton label="Discard draft" variant="secondary" disabled={!control.settled} onPress={() => setReview("discard")} />
      {control.draftCurrent ? <AppButton label="Delete template" variant="danger" disabled={!control.canStart || !data?.canConfigure} onPress={() => setReview(control.prepare("delete", control.draftCurrent ?? undefined))} /> : null}
    </OperationsPanel> : data?.canConfigure ? <AppButton label="Add graphic" disabled={!control.canStart} onPress={() => control.edit()} /> : null}
    {data ? <OperationsPanel title="Graphics library" detail={data.unknownProgram ? "Program state needs review" : `${data.activeIds.length} live${state.isError ? " · last confirmed" : ""}`}>
      {data.canTrigger && (data.activeIds.length > 0 || data.unknownProgram) ? <AppButton label="Clear program graphics" variant="danger" disabled={!control.canStart} onPress={() => setReview(control.prepare("clear"))} /> : null}
      {data.templates.length ? data.templates.map(graphic => <View key={graphic.id} style={styles.graphic}>
        <Text style={styles.title}>{graphic.title}</Text><Text style={styles.detail}>{graphic.name}{graphic.subtitle ? ` · ${graphic.subtitle}` : ""}</Text>
        <Text style={styles.status}>{data.unknownProgram ? "State unknown" : data.activeIds.includes(graphic.id) ? "Live" : "Ready"}{state.isError ? " · last confirmed" : ""}</Text>
        {data.canConfigure ? <AppButton label={`Edit ${graphic.name}`} variant="secondary" disabled={!control.canStart || !!draft} onPress={() => control.edit(graphic)} /> : null}
        {data.canTrigger ? <AppButton label={data.activeIds.includes(graphic.id) ? "Take off air" : "Take live"} variant={data.activeIds.includes(graphic.id) ? "danger" : "primary"} disabled={!control.canStart || data.unknownProgram} onPress={() => setReview(control.prepare(data.activeIds.includes(graphic.id) ? "hide" : "show", graphic))} /> : null}
      </View>) : <OperationsEmpty>No lower-third templates are available.</OperationsEmpty>}
    </OperationsPanel> : null}
    {review ? <Modal visible transparent animationType="none" onRequestClose={() => setReview(null)}>
      <View style={styles.backdrop}><ScrollView style={styles.modal}><View style={styles.modalContent}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        <Text style={styles.text}>{review === "discard" ? "This removes your unsaved draft from this session." : review.operation.kind === "clear" ? "Every program graphic will be taken off air." : review.operation.kind === "delete" ? `Permanently remove “${review.label}” from the library and take it off air if live?` : `“${review.label}” will change on the live program output.`}</Text>
        {changed ? <OperationsError message="Graphics or permissions changed while this confirmation was open. Keep current graphics, review the latest state, and try again." /> : null}
        <AppButton label={review === "discard" ? "Keep draft" : "Keep current graphics"} variant="secondary" onPress={() => setReview(null)} />
        <AppButton label={review === "discard" ? "Confirm discard" : "Confirm change"} variant="danger" disabled={changed || (review === "discard" && !control.settled)} onPress={() => {
          if (review === "discard") control.discard(); else if (!control.confirm(review)) return;
          setReview(null); setError("");
        }} />
      </View></ScrollView></View>
    </Modal> : null}
  </Page>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  text: { color: colors.text, fontSize: 14, lineHeight: 20 },
  title: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "700" },
  detail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  status: { color: colors.text, fontSize: 12, lineHeight: 18, fontWeight: "700" },
  graphic: { gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderSoft, paddingBottom: 12 },
  backdrop: { flex: 1, backgroundColor: "#00000088", justifyContent: "center", padding: 16 },
  modal: { flexGrow: 0, maxHeight: "100%", width: "100%", maxWidth: 560, alignSelf: "center", backgroundColor: colors.panel, borderRadius: 14 },
  modalContent: { padding: 16, gap: 12 },
}));
