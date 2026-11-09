import { ProPresenterControls } from "../../components/propresenter-controls";
import { StageMessageCard } from "@/components/stage-message-card";
import { useRundownItemEditor } from "@/hooks/use-rundown-item-editor";
import { RundownResetConfirmation } from "@/components/rundown-reset-confirmation";
import { useRundownChange } from "@/hooks/use-rundown-change";
import { RundownChangeStatus } from "@/components/rundown-change-status";
import { RundownClearConfirmation } from "@/components/rundown-clear-confirmation";
import { useTemplateDeleteAttempts } from "@/hooks/use-template-delete";
import {useRundownReplacementDraft} from "@/hooks/use-rundown-replacement";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams } from "expo-router";
import * as Haptics from "@/lib/haptics";
import CircleStop from "lucide-react-native/icons/circle-stop";
import Clock3 from "lucide-react-native/icons/clock-3";
import Eye from "lucide-react-native/icons/eye";
import EyeOff from "lucide-react-native/icons/eye-off";
import Files from "lucide-react-native/icons/files";
import Minus from "lucide-react-native/icons/minus";
import Pause from "lucide-react-native/icons/pause";
import Pencil from "lucide-react-native/icons/pencil";
import Play from "lucide-react-native/icons/play";
import Plus from "lucide-react-native/icons/plus";
import RotateCcw from "lucide-react-native/icons/rotate-ccw";
import SkipBack from "lucide-react-native/icons/skip-back";
import SkipForward from "lucide-react-native/icons/skip-forward";
import Share2 from "lucide-react-native/icons/share-2";
import Presentation from "lucide-react-native/icons/presentation";
import ScreenShare from "lucide-react-native/icons/screen-share";
import Trash2 from "lucide-react-native/icons/trash-2";
import Wifi from "lucide-react-native/icons/wifi";
import WifiOff from "lucide-react-native/icons/wifi-off";
import { ActivityIndicator, Alert, FlatList, Pressable, Share, StyleSheet, Text, TextInput, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import { parseRundownDuration, RundownItemSheet } from "@/components/rundown-item-sheet";
import { ShowCreationSheet } from "@/components/show-creation-sheet";
import { useShowCreationDrafts } from "@/hooks/use-show-creation";
import { nextShowStartTime, type ShowCreationDraft } from "@/lib/show-creation-recovery";
import { RundownTemplateSheet } from "@/components/rundown-template-sheet";
import { useTemplateSaveDraft } from "@/hooks/use-template-save";
import { useRundownDetailsDraft } from "@/hooks/use-rundown-details";
import { RundownShowSheet } from "@/components/rundown-show-sheet";
import { useRundownRelay } from "@/hooks/use-rundown-relay";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import {
  commandMobileRundownChange,
  getMobileRundown,
  getMobileRundownTemplates,
  updateMobileProPresenterStageDisplay,
  type MobileRundown,
  type RundownItem,
} from "@/lib/mobile-api";
import { RundownUnlock } from "@/components/rundown-unlock";
import { formatTimer, timerElapsed } from "@/lib/rundown-state";
import { shareRundownCsv, shareRundownPdf } from "@/lib/rundown-export";
import { formatServiceTime, serviceWallTimeInput } from "@/lib/service-time";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";
import { rundownItemNumbers } from "@showpilot/shared";

function titleFor(show: MobileRundown["show"]) {
  return show.name.trim() || "Untitled show";
}

function TimerPanel({
  liveReady,
  canEdit,
  canControl,
  controlsEnabled,
  editControlsEnabled,
  resetEnabled,
  onReset,
  items,
  onCommand,
  timer,
}: {
  liveReady: boolean;
  canEdit: boolean;
  canControl: boolean;
  controlsEnabled: boolean;
  editControlsEnabled: boolean;
  resetEnabled: boolean;
  onReset: () => void;
  items: RundownItem[];
  onCommand: (action: string, payload?: Record<string, unknown>) => void;
  timer: MobileRundown["timer"];
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const currentItem = items.find((item) => item.id === timer.currentItemId) ?? null;
  const [elapsed, setElapsed] = useState(() => timerElapsed(timer));
  const [customAdjust, setCustomAdjust] = useState("1:00");
  const customAdjustMs = parseRundownDuration(customAdjust);

  useEffect(() => {
    const tick = () => setElapsed(timerElapsed(timer));
    tick();
    if (!liveReady) return;
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [timer, liveReady]);

  const timerValue = timer.mode === "clock"
    ? new Date(elapsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : currentItem && timer.mode === "count-down"
      ? formatTimer(currentItem.duration - elapsed)
      : formatTimer(elapsed);
  const overtime = Boolean(currentItem && timer.mode === "count-down" && currentItem.duration - elapsed < 0);

  return (
    <View style={[styles.timerCard, overtime && styles.timerCardOvertime]}>
      <View style={styles.nowRow}>
        <View style={[styles.liveDot, (!liveReady || timer.playback !== "play") && styles.liveDotIdle]} />
        <Text style={styles.nowLabel}>{!liveReady ? "LAST KNOWN" : timer.playback === "play" ? "NOW LIVE" : timer.playback === "pause" ? "PAUSED" : "STANDBY"}</Text>
      </View>
      <Text numberOfLines={2} style={styles.currentTitle}>{currentItem?.title ?? "Select an item to begin"}</Text>
      <Text testID="rundown-timer-value" adjustsFontSizeToFit numberOfLines={1} style={[styles.timer, overtime && styles.timerOvertime]}>{timerValue}</Text>
      <Text style={styles.timerMode}>{timer.mode.replace("-", " ").toUpperCase()}</Text>

      {canEdit ? <View accessibilityRole="radiogroup" style={styles.modeRow}>
        {(["count-down", "count-up", "clock"] as const).map((mode) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: timer.mode === mode, disabled: !editControlsEnabled }} disabled={!editControlsEnabled} key={mode} onPress={() => onCommand("timer-mode", { mode })} style={[styles.modeChoice, timer.mode === mode && styles.modeChoiceActive]}><Text style={[styles.modeChoiceText, timer.mode === mode && styles.modeChoiceTextActive]}>{mode === "count-down" ? "Countdown" : mode === "count-up" ? "Count up" : "Clock"}</Text></Pressable>)}
      </View> : null}

      {canControl ? (
        <>
          <View style={styles.transport}>
            <ControlButton label="Previous" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-prev")}><SkipBack size={22} color={colors.text} /></ControlButton>
            <ControlButton
              label={timer.playback === "play" ? "Pause" : timer.playback === "pause" ? "Resume" : "Start"}
              primary
              disabled={!controlsEnabled || (!currentItem && items.every((item) => item.type === "header"))}
              onPress={() => {
                if (timer.playback === "play") onCommand("timer-pause");
                else if (timer.playback === "pause") onCommand("timer-resume");
                else {
                  const firstItem = items.find((item) => item.type !== "header" && item.status !== "complete");
                  if (firstItem) onCommand("timer-start", { itemId: firstItem.id });
                }
              }}
            >
              {timer.playback === "play" ? <Pause size={24} color={colors.black} /> : <Play size={24} color={colors.black} fill={colors.black} />}
            </ControlButton>
            <ControlButton label="Next" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-next")}><SkipForward size={22} color={colors.text} /></ControlButton>
          </View>
          <View style={styles.adjustRow}>
            <View style={styles.adjustPair}>
            <MiniButton label="−30 sec" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-adjust", { deltaMs: -30_000 })}><Minus size={16} color={colors.textMuted} /></MiniButton>
            <MiniButton label="+30 sec" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-adjust", { deltaMs: 30_000 })}><Plus size={16} color={colors.textMuted} /></MiniButton>
            </View>
            <View style={styles.adjustPair}>
            <MiniButton label="Stop" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-stop")}><CircleStop size={16} color={colors.red} /></MiniButton>
            <MiniButton label="Reset" disabled={!resetEnabled || timer.playback === "play"} onPress={onReset}><RotateCcw size={16} color={colors.textMuted} /></MiniButton>
            </View>
          </View>
          <View style={styles.customAdjustRow}>
            <TextInput accessibilityLabel="Custom timer adjustment" keyboardType="numbers-and-punctuation" maxLength={10} onChangeText={setCustomAdjust} placeholder="1:00" placeholderTextColor={colors.textFaint} style={styles.customAdjustInput} value={customAdjust} />
            <View style={styles.adjustPair}>
            <MiniButton label="Subtract" disabled={!controlsEnabled || !currentItem || customAdjustMs === null} onPress={() => customAdjustMs !== null && onCommand("timer-adjust", { deltaMs: -customAdjustMs })}><Minus size={16} color={colors.textMuted} /></MiniButton>
            <MiniButton label="Add" disabled={!controlsEnabled || !currentItem || customAdjustMs === null} onPress={() => customAdjustMs !== null && onCommand("timer-adjust", { deltaMs: customAdjustMs })}><Plus size={16} color={colors.textMuted} /></MiniButton>
            </View>
          </View>
        </>
      ) : (
        <Text style={styles.observerCopy}>You can follow every live change. An admin can grant you rundown control when you are on duty.</Text>
      )}
    </View>
  );
}

function RundownContent({ detail, orgId, orgSlug, userId, refreshError, refreshing, onRefresh }: { detail: MobileRundown; orgId: string; orgSlug: string; userId: string; refreshError?: string; refreshing: boolean; onRefresh: () => void }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const relay = useRundownRelay(orgId, detail.show.serviceDate, detail.show.id);
  const showTitle = relay.serviceName ?? titleFor(detail.show);
  const showStart = relay.scheduledStartTime === undefined ? detail.show.scheduledStartTime : relay.scheduledStartTime;
  const showCall = relay.scheduledCallTime === undefined ? detail.show.scheduledCallTime : relay.scheduledCallTime;
  const showLocation = relay.location ?? detail.show.location;
  const showSummary = [
    `${formatServiceTime(showStart, detail.timeZone)} start`,
    showCall ? `${formatServiceTime(showCall, detail.timeZone)} call` : null,
    showLocation || null,
  ].filter(Boolean).join(" · ");
  const [editorOpen, setEditorOpen] = useState(false);
  const [newShow, setNewShow] = useState<ShowCreationDraft | null>(null);
  const showDrafts = useShowCreationDrafts({ orgId, userId });
  function openNewShow() {
    const initial: ShowCreationDraft = { serviceDate: detail.show.serviceDate, timeZone: detail.timeZone, name: "", location: showLocation,
      startTime: nextShowStartTime(serviceWallTimeInput(showStart, detail.timeZone)), callTime: "",
      source: { kind: "show", id: detail.show.id, name: showTitle, serviceDate: detail.show.serviceDate } };
    setNewShow(showDrafts[0] ?? initial);
  }
  const [showDetailsOpen, setShowDetailsOpen] = useState(false);
  const detailsDraft = useRundownDetailsDraft({ orgId, userId, showId: detail.show.id });
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templateDeletions = useTemplateDeleteAttempts({orgId,userId,showId:detail.show.id});
  const templateDraft = useTemplateSaveDraft({ orgId, userId, showId: detail.show.id });
  const replacementDraft=useRundownReplacementDraft({orgId,userId,showId:detail.show.id});
  const [stageDisplayEnabled, setStageDisplayEnabled] = useState(detail.proPresenter.stageDisplayEnabled);
  const seededRef = useRef(false);
  const sameRoom = relay.showId === detail.show.id && relay.serviceDate === detail.show.serviceDate;
  // Keep the last relay snapshot during reconnect, including an empty list.
  // Falling back to older HTTP data would resurrect items deleted elsewhere.
  const hasRelayState = sameRoom && relay.initialized;
  const items = hasRelayState ? relay.items : detail.items;
  const itemNumbers = rundownItemNumbers(items);
  const timer = hasRelayState ? relay.timer : detail.timer;
  const canAuthor = detail.canEdit;
  const canUseLiveRelay = detail.canEdit || detail.canControl;
  const templatesQuery = useQuery({
    queryKey: ["mobile-rundown-templates", orgId, detail.show.id, userId],
    networkMode: "always", retry: false,
    queryFn: () => getMobileRundownTemplates(orgId, detail.show.id),
    enabled: canAuthor,
  });
  const stageDisplay = useMutation({
    mutationFn: (enabled: boolean) => updateMobileProPresenterStageDisplay({
      orgId,
      showId: detail.show.id,
      enabled,
    }),
    onSuccess: ({ enabled }) => setStageDisplayEnabled(enabled),
    onError: (error) => Alert.alert("Stage display was not changed", error.message),
  });
  const liveReady = relay.status === "connected" && relay.hydrated && sameRoom;
  const controlsEnabled = detail.canControl && liveReady && relay.unconfirmedCount === 0;
  const editControlsEnabled = canAuthor && liveReady;
  const liveWriteEnabled = canUseLiveRelay && liveReady;
  const client = useQueryClient();
  const changes = useRundownChange({ orgId, userId, showId: detail.show.id, serviceDate: detail.show.serviceDate }, {
    active: liveWriteEnabled,
    send: commandMobileRundownChange,
    refresh: async signal => {
      await client.invalidateQueries({ queryKey: ["mobile-rundown", orgId, detail.show.id, userId] }, { throwOnError: true });
      if (signal.aborted) throw new Error("Rundown refresh cancelled.");
    },
  });
  const itemEditor=useRundownItemEditor({orgId,userId,showId:detail.show.id,serviceDate:detail.show.serviceDate}, {
    active:canAuthor, canSubmit:editControlsEnabled && !changes.attempt,
    revision:relay.revision, items, send:commandMobileRundownChange,
    refresh:async signal=>{
      await client.invalidateQueries({queryKey:["mobile-rundown",orgId,detail.show.id,userId]}, {throwOnError:true});
      if(signal.aborted) throw new Error("Rundown refresh cancelled.");
    },
  });
  const itemDraftTitle = itemEditor.draft?.fields.title || "New item";
  function openItem(item:RundownItem | null) {
    itemEditor.open(item);
    setEditorOpen(true);
  }
  const [clearOpen, setClearOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const canReset = controlsEnabled && !changes.attempt;
  const canRemove = editControlsEnabled && !changes.attempt && !itemEditor.attempt;


  useEffect(() => {
    if (!relay.hydrated || seededRef.current) return;
    if (sameRoom && !relay.initialized && canUseLiveRelay) {
      seededRef.current = true;
      relay.seedState(detail.items, detail.timer, {
        serviceName: detail.show.name,
        scheduledStartTime: detail.show.scheduledStartTime,
        scheduledCallTime: detail.show.scheduledCallTime,
        location: detail.show.location,
      });
    } else if (sameRoom && (relay.initialized || !canUseLiveRelay)) {
      seededRef.current = true;
    }
  }, [canUseLiveRelay, detail, relay, sameRoom]);

  async function command(action: string, payload?: Record<string, unknown>) {
    if (!controlsEnabled) return;
    await Haptics.selectionAsync();
    relay.sendCommand(action, payload);
  }

  function startItem(item: RundownItem) {
    if (item.type === "header" || !controlsEnabled) return;
    void command("timer-start", { itemId: item.id });
  }

  function deleteItem(item: RundownItem, revision: number) {
    if (!canRemove || revision !== relay.revision) return;
    changes.confirm({ action: "remove-item", itemId: item.id }, revision, item.title);
    itemEditor.discard();
    setEditorOpen(false);
  }

  function exportRundown(format: "csv" | "pdf") {
    const scheduledStart = relay.scheduledStartTime ?? detail.show.scheduledStartTime;
    const startTime = scheduledStart
      ? new Date(scheduledStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null;
    const action = format === "csv"
      ? shareRundownCsv({ title: showTitle, serviceDate: detail.show.serviceDate, items })
      : shareRundownPdf({ title: showTitle, serviceDate: detail.show.serviceDate, startTime, items });
    void action.catch((error: unknown) => {
      Alert.alert("Export failed", error instanceof Error ? error.message : "Try again.");
    });
  }

  function shareKioskLink() {
    const url = `${SHOWPILOT_URL}/timer/${encodeURIComponent(orgSlug)}`;
    void Share.share({
      title: `${showTitle} stage display`,
      message: `${showTitle} stage display\n${url}`,
      url,
    }).catch((error: unknown) => {
      Alert.alert("Could not share stage display", error instanceof Error ? error.message : "Try again.");
    });
  }

  const connectionText = relay.status === "connected"
    ? liveReady ? "Live sync" : "Waiting for live state"
    : relay.status === "offline"
      ? "Paused in background"
      : "Reconnecting";

  return (
    <Page
      action={detail.canCreateShows ? <Pressable accessibilityLabel="Create another show" accessibilityRole="button" onPress={openNewShow} style={styles.newShowButton}><Plus color={colors.black} size={16} /><Text style={styles.newShowText}>{showDrafts[0] ? "Resume show" : "New show"}</Text></Pressable> : null}
      backTo="/(app)/shows"
      backLabel="Back to shows"
      eyebrow={detail.show.serviceDate}
      title={showTitle}
      subtitle={showSummary}
      scroll={false}
    >
      <FlatList
        contentContainerStyle={styles.list}
        data={items}
        initialNumToRender={12}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>This show has no rundown items yet.</Text>}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            <RundownChangeStatus state={changes} active={changes.attempt?.command.action === "reset" ? detail.canControl && liveReady : editControlsEnabled} revision={relay.revision} itemIds={items.map(item => item.id)}/>
            {resetOpen ? <RundownResetConfirmation title={showTitle} count={items.length} revision={relay.revision} playing={timer.playback === "play"} active={canReset} onClose={() => setResetOpen(false)} onConfirm={revision => {
              if (!canReset || revision !== relay.revision || timer.playback === "play") return;
              changes.confirm({action:"reset"}, revision, showTitle);
              setResetOpen(false);
            }}/> : null}
            {clearOpen ? <RundownClearConfirmation title={showTitle} count={items.length} revision={relay.revision} playing={timer.playback !== "stop"} active={canRemove} onClose={() => setClearOpen(false)} onConfirm={revision => { if (!canRemove || revision !== relay.revision) return; changes.confirm({action:"clear-all"}, revision, showTitle); setClearOpen(false); }}/> : null}
            {refreshError ? <View><Text accessibilityRole="alert" style={styles.syncError}>{refreshError} The last loaded show is still displayed.</Text><AppButton label="Refresh show" loading={refreshing} onPress={onRefresh} /></View> : null}
            {templateDeletions.length ? <AppButton label="Resume template deletion" variant="secondary" onPress={()=>setTemplatesOpen(true)}/>:null}
            {replacementDraft ? <AppButton label="Resume rundown replacement" variant="secondary" onPress={()=>setTemplatesOpen(true)}/>:null}
            {templateDraft?.name ? <AppButton label="Resume template draft" variant="secondary" onPress={() => setTemplatesOpen(true)}/> : null}
            {itemEditor.draft ? <View style={{gap:8}}><AppButton accessibilityLabel={`Resume item draft: ${itemDraftTitle}`} label={`Resume item draft: ${itemDraftTitle.length > 80 ? itemDraftTitle.slice(0, 77) + "…" : itemDraftTitle}`} variant="secondary" onPress={()=>setEditorOpen(true)}/><Text style={styles.observerCopy}>Finish or discard this draft before editing another item.</Text></View> : null}
            {detailsDraft ? <AppButton label="Resume rundown details" variant="secondary" onPress={() => setShowDetailsOpen(true)} /> : null}
            <View style={styles.connectionRow}>
              {liveReady ? <Wifi size={15} color={colors.green} /> : <WifiOff size={15} color={colors.amberText} />}
              <Text style={[styles.connectionText, liveReady && styles.connected]}>{connectionText}{relay.unconfirmedCount ? ` · ${relay.unconfirmedCount} changes awaiting confirmation` : ""}</Text>
              <View style={styles.permissionBadge}>
                <Text style={styles.permissionText}>{detail.canControl ? "OPERATOR" : canAuthor ? "EDITOR" : "VIEW ONLY"}</Text>
              </View>
              <Pressable accessibilityLabel="Share stage display link" accessibilityRole="button" onPress={shareKioskLink} style={styles.connectionAction}><ScreenShare color={colors.textMuted} size={15} /></Pressable>
              {canAuthor ? <Pressable accessibilityLabel="Edit show details" accessibilityRole="button" disabled={!editControlsEnabled} onPress={() => setShowDetailsOpen(true)} style={[styles.connectionAction, !editControlsEnabled && styles.disabled]}><Pencil color={colors.textMuted} size={15} /></Pressable> : null}
            </View>
            {relay.lastError ? <Text accessibilityRole="alert" style={styles.syncError}>{relay.lastError}</Text> : null}
            {relay.commandError ? <AppButton label="Dismiss rundown notice" variant="secondary" onPress={relay.dismissCommandError}/> : null}
            {!liveReady ? <AppButton label="Retry live connection" variant="secondary" onPress={relay.retryConnection} /> : null}
            <RundownUnlock userId={userId} orgId={orgId} showId={detail.show.id} pinAccess={detail.pinAccess} />
            <TimerPanel
              liveReady={liveReady}
              resetEnabled={canReset}
              onReset={() => setResetOpen(true)}
              canEdit={canAuthor}
              canControl={detail.canControl}
              controlsEnabled={controlsEnabled}
              editControlsEnabled={editControlsEnabled}
              items={items}
              onCommand={(action, payload) => void command(action, payload)}
              timer={timer}
            />
            {canUseLiveRelay && detail.proPresenter.configured ? <View style={styles.ppCard}>
              <View style={styles.ppHeading}><View style={styles.ppTitleRow}><Presentation color={colors.amberText} size={17} /><Text style={styles.ppTitle}>PROPRESENTER</Text></View><Text style={[styles.ppStatus, detail.proPresenter.connected && styles.ppStatusConnected]}>{detail.proPresenter.connected ? "CONNECTED" : detail.proPresenter.bridgeOnline ? "READY" : "BRIDGE OFFLINE"}</Text></View>
              {relay.ppPreviewSlide ? <View style={styles.ppPreview}><Text numberOfLines={1} style={styles.ppPresentation}>{relay.ppPreviewSlide.presentationName || "Current slide"}</Text><Text numberOfLines={5} style={styles.ppText}>{relay.ppPreviewSlide.text || "Blank slide"}</Text>{relay.ppPreviewSlide.notes ? <Text numberOfLines={2} style={styles.ppNotes}>{relay.ppPreviewSlide.notes}</Text> : null}</View> : <Text style={styles.ppEmpty}>No active slide preview. Commands will connect through the Venue Bridge.</Text>}
              <Pressable
                accessibilityLabel="Show ProPresenter slides on stage displays"
                accessibilityRole="switch"
                accessibilityState={{ checked: stageDisplayEnabled, disabled: stageDisplay.isPending }}
                disabled={stageDisplay.isPending}
                onPress={() => stageDisplay.mutate(!stageDisplayEnabled)}
                style={[styles.ppStageToggle, stageDisplayEnabled && styles.ppStageToggleActive, stageDisplay.isPending && styles.disabled]}
              >
                {stageDisplayEnabled ? <Eye color={colors.green} size={17} /> : <EyeOff color={colors.textFaint} size={17} />}
                <View style={styles.ppStageCopy}><Text style={styles.ppStageTitle}>{stageDisplayEnabled ? "Visible on stage displays" : "Hidden from stage displays"}</Text><Text style={styles.ppStageHint}>Controls live slide and scripture streaming on kiosk displays.</Text></View>
              </Pressable>
              {detail.canControl ? <>
                {!detail.proPresenter.cuesEnabled ? <Text style={styles.ppWarning}>Enable “Send cues” in Settings → ProPresenter before using remote slide controls.</Text> : null}
                <ProPresenterControls key={`${userId}:${orgId}:${detail.show.id}`} scope={{ userId, orgId, showId: detail.show.id }} ready={liveReady && detail.proPresenter.cuesEnabled && detail.proPresenter.bridgeOnline} />
              </> : null}
            </View> : null}
            {canUseLiveRelay || relay.stageMessage ? <StageMessageCard key={`${userId}:${orgId}:${detail.show.id}`}
              scope={{orgId,userId,showId:detail.show.id,serviceDate:detail.show.serviceDate}}
              canWrite={canUseLiveRelay} ready={liveReady} revision={relay.revision} message={relay.stageMessage}/> : null}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>RUNDOWN</Text>
              <View style={styles.sectionActions}><Text style={styles.sectionCount}>{items.length} ITEMS</Text><Pressable accessibilityLabel="Export rundown" accessibilityRole="button" onPress={() => Alert.alert("Export rundown", "Choose a shareable format.", [{ text: "Cancel", style: "cancel" }, { text: "CSV", onPress: () => exportRundown("csv") }, { text: "PDF", onPress: () => exportRundown("pdf") }])} style={styles.templateButton}><Share2 color={colors.textMuted} size={16} /></Pressable>{canAuthor ? <><Pressable accessibilityLabel="Open rundown templates" accessibilityRole="button" onPress={() => setTemplatesOpen(true)} style={styles.templateButton}><Files color={colors.textMuted} size={16} /></Pressable>{items.length > 0 ? <Pressable accessibilityLabel="Clear rundown" accessibilityRole="button" disabled={!canRemove} onPress={() => setClearOpen(true)} style={[styles.templateButton, !editControlsEnabled && styles.disabled]}><Trash2 color={colors.red} size={16} /></Pressable> : null}<Pressable accessibilityLabel="Add rundown item" accessibilityRole="button" disabled={!editControlsEnabled || !!itemEditor.draft} onPress={() => openItem(null)} style={[styles.addItem, (!editControlsEnabled || !!itemEditor.draft) && styles.disabled]}><Plus color={colors.black} size={16} /><Text style={styles.addItemText}>Add</Text></Pressable></> : null}</View>
            </View>
          </View>
        )}
        maxToRenderPerBatch={12}
        renderItem={({ item, index }) => {
          const active = item.id === timer.currentItemId;
          const header = item.type === "header";
          return (
            <View key={item.id} style={[header ? styles.itemHeader : styles.item, active && styles.itemActive]}>
              <Pressable accessibilityRole={!header && detail.canControl ? "button" : undefined} accessibilityState={!header && detail.canControl ? { disabled: !controlsEnabled } : undefined} disabled={header || !controlsEnabled} onPress={() => startItem(item)} style={({ pressed }) => [styles.itemMain, pressed && styles.itemPressed]}>
              {header ? (
                <Text style={styles.headerTitle}>{itemNumbers.get(item.id)}  {item.title}</Text>
              ) : (
                <>
                  <View style={[styles.itemIndex, active && styles.itemIndexActive]}><Text style={[styles.itemIndexText, active && styles.itemIndexTextActive]}>{itemNumbers.get(item.id)}</Text></View>
                  <View style={styles.itemCopy}>
                    <Text numberOfLines={2} style={[styles.itemTitle, active && styles.itemTitleActive]}>{item.title}</Text>
                    <Text style={styles.itemMeta}>{formatTimer(item.duration)}{item.assignee ? `  ·  ${item.assignee}` : ""}</Text>
                  </View>
                  {active ? <View style={styles.activeBars}><View style={styles.bar} /><View style={styles.barTall} /><View style={styles.bar} /></View> : item.hardStop ? <Clock3 size={16} color={colors.red} /> : null}
                </>
              )}
              </Pressable>
              {canAuthor ? <Pressable accessibilityLabel={`Edit ${item.title}`} accessibilityRole="button" disabled={!editControlsEnabled || !!itemEditor.draft} onPress={() => openItem(item)} style={[styles.editItem, (!editControlsEnabled || !!itemEditor.draft) && styles.disabled]}><Pencil color={colors.textMuted} size={16} /></Pressable> : null}
            </View>
          );
        }}
        windowSize={7}
      />
      {editorOpen && itemEditor.draft ? <RundownItemSheet key={itemEditor.draft.id}
        state={itemEditor} items={items} serviceDate={detail.show.serviceDate}
        currentItem={items.find(item=>item.id === itemEditor.draft?.id) ?? null} currentItemId={timer.currentItemId}
        revision={relay.revision} canEdit={editControlsEnabled && !changes.attempt}
        index={items.findIndex(item=>item.id === itemEditor.draft?.id)} item={itemEditor.draft.base.item} itemCount={items.length}
        onClose={()=>setEditorOpen(false)} onDelete={deleteItem}/> : null}
      {templatesOpen ? <RundownTemplateSheet
        key={`${userId}:${orgId}:${detail.show.id}`} orgId={orgId} userId={userId} showId={detail.show.id}
        copy={{ serviceName: showTitle, scheduledStartTime: serviceWallTimeInput(showStart, detail.timeZone), items }} canCapture={editControlsEnabled}
        error={canAuthor ? templatesQuery.error?.message : "Rundown editing permission is unavailable. Reopen after your access is restored."} refreshing={templatesQuery.isFetching} onRetry={() => void templatesQuery.refetch()}
        loading={templatesQuery.isPending && templatesQuery.isFetching}
        onClose={() => setTemplatesOpen(false)}
        previousShows={templatesQuery.data?.previousShows ?? []}
        templates={templatesQuery.data?.templates ?? []}
      /> : null}
      {showDetailsOpen ? <RundownShowSheet key={`${userId}:${orgId}:${detail.show.id}`} orgId={orgId} userId={userId} showId={detail.show.id} onClose={() => setShowDetailsOpen(false)} /> : null}
      {newShow ? <ShowCreationSheet key={`${userId}:${orgId}`} orgId={orgId} userId={userId} initial={newShow} shows={[{ ...detail.show, name: showTitle, scheduledStartTime: showStart, scheduledCallTime: showCall, location: showLocation ?? "" }]} onClose={() => setNewShow(null)} /> : null}
    </Page>
  );
}

function ControlButton({ children, label, primary, disabled, onPress }: { children: React.ReactNode; label: string; primary?: boolean; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.control, primary && styles.controlPrimary, disabled && styles.disabled, pressed && styles.pressed]}>
      {children}
      <Text style={[styles.controlLabel, primary && styles.controlLabelPrimary]}>{label}</Text>
    </Pressable>
  );
}

function MiniButton({ children, label, disabled, onPress }: { children: React.ReactNode; label: string; disabled?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.miniButton, disabled && styles.disabled, pressed && styles.pressed]}>
      {children}<Text style={styles.miniLabel}>{label}</Text>
    </Pressable>
  );
}

export default function ShowDetailScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const { showId } = useLocalSearchParams<{ showId: string }>();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const query = useQuery({
    queryKey: ["mobile-rundown", organization?.id, showId, session?.user.id],
    networkMode: "always",
    retry: false,
    queryFn: () => getMobileRundown(organization!.id, showId),
    enabled: Boolean(session?.user.id && organization?.id && showId),
  });

  if (sessionPending || organizationPending) {
    return <Page backTo="/(app)/shows" backLabel="Back to shows"><ActivityIndicator style={styles.loading} color={colors.amber} size="large" /></Page>;
  }
  if (!session) return <Redirect href="/sign-in" />;
  if (!organization) return <Redirect href="/organizations" />;
  if (query.isPending) return <Page backTo="/(app)/shows" backLabel="Back to shows"><ActivityIndicator style={styles.loading} color={colors.amber} size="large" /></Page>;
  if (!query.data) {
    return (
      <Page backTo="/(app)/shows" backLabel="Back to shows" eyebrow="RUNDOWN" title="Could not open show">
        <Text style={styles.syncError}>{query.error?.message ?? "The show is unavailable."}</Text>
        <AppButton label="Try again" onPress={() => query.refetch()} />
      </Page>
    );
  }
  return <RundownContent key={`${session.user.id}:${organization.id}:${query.data.show.id}:${query.data.pinAccess}`} userId={session.user.id} refreshError={query.error?.message} refreshing={query.isFetching} onRefresh={() => void query.refetch()} detail={query.data} orgId={organization.id} orgSlug={organization.slug} />;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  loading: { flex: 1 },
  connectionRow: { minHeight: 44, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  connectionText: { flexGrow: 1, minWidth: 80, color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "700" },
  connected: { color: colors.green },
  permissionBadge: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingHorizontal: 9, paddingVertical: 5 },
  permissionText: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  connectionAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 17, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  newShowButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radii.pill, backgroundColor: colors.amber, paddingHorizontal: 12 },
  newShowText: { color: colors.black, fontFamily, fontSize: 12, fontWeight: "900" },
  timerCard: { alignItems: "center", gap: 10, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.large },
  timerCardOvertime: { borderColor: colors.redStrongBorder, backgroundColor: colors.redSoft },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  liveDotIdle: { backgroundColor: colors.textFaint },
  nowLabel: { color: colors.textFaint, fontFamily, fontSize: 12, fontWeight: "900", letterSpacing: 1.8 },
  currentTitle: { minHeight: 24, color: colors.text, fontFamily, fontSize: 18, lineHeight: 24, fontWeight: "700", textAlign: "center" },
  timer: { width: "100%", color: colors.amberText, fontFamily: "monospace", fontSize: 66, lineHeight: 74, fontWeight: "800", letterSpacing: -4, textAlign: "center" },
  timerOvertime: { color: colors.red },
  timerMode: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  modeRow: { width: "100%", flexDirection: "row", gap: 7 },
  modeChoice: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised },
  modeChoiceActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  modeChoiceText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700" },
  modeChoiceTextActive: { color: colors.amberText },
  transport: { width: "100%", flexDirection: "row", gap: 10, marginTop: 10 },
  control: { flex: 1, minHeight: 67, alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong },
  controlPrimary: { backgroundColor: colors.amber, borderColor: colors.amber },
  controlLabel: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "700" },
  controlLabelPrimary: { color: colors.black },
  adjustRow: { width: "100%", flexDirection: "row", flexWrap: "wrap", gap: 8 },
  customAdjustRow: { width: "100%", flexDirection: "row", flexWrap: "wrap", gap: 8 },
  adjustPair: { flex: 1, minWidth: 216, flexDirection: "row", gap: 8 },
  customAdjustInput: { flex: 1, minWidth: 100, minHeight: 44, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, color: colors.text, fontFamily: "monospace", fontSize: 13, textAlign: "center", paddingHorizontal: 8 },
  miniButton: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  miniLabel: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700" },
  observerCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", marginTop: 8 },
  syncError: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 19 },
  ppCard: { gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 13 },
  ppHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  ppTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  ppTitle: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.3 },
  ppStatus: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  ppStatusConnected: { color: colors.green },
  ppPreview: { gap: 5, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 11 },
  ppPresentation: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  ppText: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20 },
  ppNotes: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 16 },
  ppEmpty: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  ppStageToggle: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 10 },
  ppStageToggleActive: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  ppStageCopy: { flex: 1, minWidth: 0, gap: 2 },
  ppStageTitle: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  ppStageHint: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 15 },
  ppWarning: { color: colors.amberText, fontFamily, fontSize: 11, lineHeight: 17 },
  activeMessagePriorityText: { color: colors.red },
  sectionHeading: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.6 },
  sectionCount: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  sectionActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  addItem: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radii.pill, backgroundColor: colors.amber, paddingHorizontal: 12 },
  addItemText: { color: colors.black, fontFamily, fontSize: 11, fontWeight: "800" },
  templateButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  list: { gap: 8, paddingBottom: spacing.large },
  listHeader: { gap: spacing.large, marginBottom: 8 },
  item: { minHeight: 68, flexDirection: "row", alignItems: "center", borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, paddingLeft: 12 },
  itemActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  itemPressed: { opacity: 0.72 },
  itemHeader: { minHeight: 52, flexDirection: "row", alignItems: "center", marginTop: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  itemMain: { flex: 1, minWidth: 0, minHeight: 50, flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  editItem: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.3, textTransform: "uppercase" },
  itemIndex: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: colors.panelStrong },
  itemIndexActive: { backgroundColor: colors.amber },
  itemIndexText: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800" },
  itemIndexTextActive: { color: colors.black },
  itemCopy: { flex: 1, minWidth: 0, gap: 5 },
  itemTitle: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, fontWeight: "700" },
  itemTitleActive: { color: colors.amberText },
  itemMeta: { color: colors.textFaint, fontFamily, fontSize: 11 },
  activeBars: { width: 18, height: 18, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2 },
  bar: { width: 2, height: 8, borderRadius: 1, backgroundColor: colors.green },
  barTall: { width: 2, height: 15, borderRadius: 1, backgroundColor: colors.green },
  empty: { color: colors.textMuted, fontFamily, fontSize: 14, lineHeight: 21, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
}));
