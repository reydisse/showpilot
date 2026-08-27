import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
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
import Send from "lucide-react-native/icons/send";
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
import { RundownTemplateSheet } from "@/components/rundown-template-sheet";
import { RundownShowSheet } from "@/components/rundown-show-sheet";
import { useRundownRelay } from "@/hooks/use-rundown-relay";
import { authClient } from "@/lib/auth-client";
import { SHOWPILOT_URL } from "@/lib/env";
import {
  deleteMobileRundownTemplate,
  controlMobileProPresenter,
  getMobileRundown,
  getMobileRundownTemplates,
  loadMobilePreviousRundown,
  loadMobileRundownTemplate,
  saveMobileRundownTemplate,
  updateMobileRundownMeta,
  updateMobileProPresenterStageDisplay,
  type MobileRundown,
  type RundownItem,
} from "@/lib/mobile-api";
import { formatTimer, timerElapsed } from "@/lib/rundown-state";
import { shareRundownCsv, shareRundownPdf } from "@/lib/rundown-export";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

function titleFor(show: MobileRundown["show"]) {
  return show.name.trim() || "Untitled show";
}

function TimerPanel({
  canEdit,
  canControl,
  controlsEnabled,
  editControlsEnabled,
  items,
  onCommand,
  timer,
}: {
  canEdit: boolean;
  canControl: boolean;
  controlsEnabled: boolean;
  editControlsEnabled: boolean;
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
    const interval = setInterval(tick, 100);
    return () => clearInterval(interval);
  }, [timer]);

  const timerValue = timer.mode === "clock"
    ? new Date(elapsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : currentItem && timer.mode === "count-down"
      ? formatTimer(currentItem.duration - elapsed)
      : formatTimer(elapsed);
  const overtime = Boolean(currentItem && timer.mode === "count-down" && currentItem.duration - elapsed < 0);

  return (
    <View style={[styles.timerCard, overtime && styles.timerCardOvertime]}>
      <View style={styles.nowRow}>
        <View style={[styles.liveDot, timer.playback !== "play" && styles.liveDotIdle]} />
        <Text style={styles.nowLabel}>{timer.playback === "play" ? "NOW LIVE" : timer.playback === "pause" ? "PAUSED" : "STANDBY"}</Text>
      </View>
      <Text numberOfLines={2} style={styles.currentTitle}>{currentItem?.title ?? "Select an item to begin"}</Text>
      <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.timer, overtime && styles.timerOvertime]}>{timerValue}</Text>
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
            <MiniButton label="−30 sec" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-adjust", { deltaMs: -30_000 })}><Minus size={16} color={colors.textMuted} /></MiniButton>
            <MiniButton label="+30 sec" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-adjust", { deltaMs: 30_000 })}><Plus size={16} color={colors.textMuted} /></MiniButton>
            <MiniButton label="Stop" disabled={!controlsEnabled || !currentItem} onPress={() => onCommand("timer-stop")}><CircleStop size={16} color={colors.red} /></MiniButton>
            <MiniButton label="Reset" disabled={!controlsEnabled} onPress={() => onCommand("reset")}><RotateCcw size={16} color={colors.textMuted} /></MiniButton>
          </View>
          <View style={styles.customAdjustRow}>
            <TextInput accessibilityLabel="Custom timer adjustment" keyboardType="numbers-and-punctuation" maxLength={10} onChangeText={setCustomAdjust} placeholder="1:00" placeholderTextColor={colors.textFaint} style={styles.customAdjustInput} value={customAdjust} />
            <MiniButton label="Subtract" disabled={!controlsEnabled || !currentItem || customAdjustMs === null} onPress={() => customAdjustMs !== null && onCommand("timer-adjust", { deltaMs: -customAdjustMs })}><Minus size={16} color={colors.textMuted} /></MiniButton>
            <MiniButton label="Add" disabled={!controlsEnabled || !currentItem || customAdjustMs === null} onPress={() => customAdjustMs !== null && onCommand("timer-adjust", { deltaMs: customAdjustMs })}><Plus size={16} color={colors.textMuted} /></MiniButton>
          </View>
        </>
      ) : (
        <Text style={styles.observerCopy}>You can follow every live change. An admin can grant you rundown control when you are on duty.</Text>
      )}
    </View>
  );
}

function RundownContent({ detail, orgId, orgSlug }: { detail: MobileRundown; orgId: string; orgSlug: string }) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const relay = useRundownRelay(orgId, detail.show.serviceDate, detail.show.id);
  const showTitle = relay.serviceName ?? titleFor(detail.show);
  const [editor, setEditor] = useState<{ item: RundownItem | null; index: number } | null>(null);
  const [showDetailsOpen, setShowDetailsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messagePriority, setMessagePriority] = useState(false);
  const [stageDisplayEnabled, setStageDisplayEnabled] = useState(detail.proPresenter.stageDisplayEnabled);
  const seededRef = useRef(false);
  const sameRoom = relay.showId === detail.show.id && relay.serviceDate === detail.show.serviceDate;
  // Once the relay identifies this room, its empty list is authoritative.
  // Falling back to the HTTP snapshot would resurrect items deleted elsewhere.
  const relayIsAuthoritative = relay.hydrated && sameRoom && relay.initialized;
  const items = relayIsAuthoritative ? relay.items : detail.items;
  const timer = relayIsAuthoritative ? relay.timer : detail.timer;
  const canEdit = detail.canEdit || detail.canControl;
  const templatesQuery = useQuery({
    queryKey: ["mobile-rundown-templates", orgId, detail.show.id],
    queryFn: () => getMobileRundownTemplates(orgId, detail.show.id),
    enabled: canEdit,
  });
  const proPresenter = useMutation({
    mutationFn: (command: "next" | "previous" | "clear") => controlMobileProPresenter({
      orgId,
      showId: detail.show.id,
      command,
    }),
    onError: (error) => Alert.alert("ProPresenter command failed", error.message),
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
  const controlsEnabled = detail.canControl && liveReady;
  const editControlsEnabled = canEdit && liveReady;

  useEffect(() => {
    if (!relay.hydrated || seededRef.current) return;
    if (sameRoom && !relay.initialized && canEdit) {
      seededRef.current = true;
      relay.seedState(detail.items, detail.timer, {
        serviceName: detail.show.name,
        scheduledStartTime: detail.show.scheduledStartTime,
        location: detail.show.location,
      });
    } else if (sameRoom && (relay.initialized || !canEdit)) {
      seededRef.current = true;
    }
  }, [canEdit, detail, relay, sameRoom]);

  const displayStageMessage = relay.stageMessage.replace(/^!!PRIORITY!!/, "");
  const stageMessagePriority = relay.stageMessage.startsWith("!!PRIORITY!!");
  useEffect(() => {
    setMessage(relay.stageMessage.replace(/^!!PRIORITY!!/, ""));
    setMessagePriority(relay.stageMessage.startsWith("!!PRIORITY!!"));
  }, [relay.stageMessage]);

  async function command(action: string, payload?: Record<string, unknown>) {
    if (!controlsEnabled) return;
    await Haptics.selectionAsync();
    relay.sendCommand(action, payload);
  }

  function startItem(item: RundownItem) {
    if (item.type === "header" || !controlsEnabled) return;
    void command("timer-start", { itemId: item.id });
  }

  function saveItem(item: RundownItem) {
    if (!editControlsEnabled) return;
    if (editor?.item) {
      relay.sendCommand("update-item", {
        id: editor.item.id,
        updates: {
          title: item.title,
          type: item.type,
          duration: item.duration,
          notes: item.notes,
          assignee: item.assignee,
          cue: item.cue,
          hardStop: item.hardStop,
        },
      });
    } else {
      relay.sendCommand("add-item", {
        id: item.id,
        title: item.title,
        type: item.type,
        duration: item.duration,
        notes: item.notes,
        assignee: item.assignee,
        cue: item.cue,
        status: "upcoming",
        sortOrder: items.length,
        hardStop: item.hardStop,
      });
    }
  }

  function moveItem(item: RundownItem, direction: "up" | "down") {
    const index = items.findIndex((candidate) => candidate.id === item.id);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (!editControlsEnabled || index < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    const reordered = [...items];
    [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
    relay.sendCommand("reorder", { order: reordered.map((candidate) => candidate.id) });
    setEditor(null);
  }

  function deleteItem(item: RundownItem) {
    Alert.alert("Delete rundown item?", `Remove “${item.title}” from this show?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => {
        if (timer.currentItemId === item.id) relay.sendCommand("timer-stop");
        relay.sendCommand("remove-item", { id: item.id });
        setEditor(null);
      } },
    ]);
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
    ? "Live sync"
    : relay.status === "offline"
      ? "Paused in background"
      : "Reconnecting";

  return (
    <Page eyebrow={detail.show.serviceDate} title={showTitle} scroll={false}>
      <Stack.Screen options={{ title: showTitle }} />
      <FlatList
        contentContainerStyle={styles.list}
        data={items}
        initialNumToRender={12}
        keyExtractor={(item) => item.id}
        ListEmptyComponent={<Text style={styles.empty}>This show has no rundown items yet.</Text>}
        ListHeaderComponent={(
          <View style={styles.listHeader}>
            <View style={styles.connectionRow}>
              {relay.status === "connected" ? <Wifi size={15} color={colors.green} /> : <WifiOff size={15} color={colors.amberText} />}
              <Text style={[styles.connectionText, relay.status === "connected" && styles.connected]}>{connectionText}</Text>
              <View style={styles.permissionBadge}>
                <Text style={styles.permissionText}>{detail.canControl ? "OPERATOR" : canEdit ? "EDITOR" : "VIEW ONLY"}</Text>
              </View>
              <Pressable accessibilityLabel="Share stage display link" accessibilityRole="button" onPress={shareKioskLink} style={styles.connectionAction}><ScreenShare color={colors.textMuted} size={15} /></Pressable>
              {canEdit ? <Pressable accessibilityLabel="Edit show details" accessibilityRole="button" disabled={!editControlsEnabled} onPress={() => setShowDetailsOpen(true)} style={[styles.connectionAction, !editControlsEnabled && styles.disabled]}><Pencil color={colors.textMuted} size={15} /></Pressable> : null}
            </View>
            <TimerPanel
              canEdit={canEdit}
              canControl={detail.canControl}
              controlsEnabled={controlsEnabled}
              editControlsEnabled={editControlsEnabled}
              items={items}
              onCommand={(action, payload) => void command(action, payload)}
              timer={timer}
            />
            {relay.lastError ? <Text style={styles.syncError}>{relay.lastError}</Text> : null}
            {canEdit && detail.proPresenter.configured ? <View style={styles.ppCard}>
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
                <View style={styles.ppControls}>
                  <MiniButton disabled={proPresenter.isPending || !detail.proPresenter.cuesEnabled || !detail.proPresenter.bridgeOnline} label="Previous" onPress={() => proPresenter.mutate("previous")}><SkipBack color={colors.textMuted} size={16} /></MiniButton>
                  <MiniButton disabled={proPresenter.isPending || !detail.proPresenter.cuesEnabled || !detail.proPresenter.bridgeOnline} label="Next" onPress={() => proPresenter.mutate("next")}><SkipForward color={colors.textMuted} size={16} /></MiniButton>
                  <MiniButton disabled={proPresenter.isPending || !detail.proPresenter.cuesEnabled || !detail.proPresenter.bridgeOnline} label="Clear" onPress={() => proPresenter.mutate("clear")}><CircleStop color={colors.red} size={16} /></MiniButton>
                </View>
              </> : null}
            </View> : null}
            {canEdit ? <View style={styles.messageCard}>
              <View style={styles.messageHeading}><Text style={styles.messageTitle}>STAGE MESSAGE</Text>{relay.stageMessage ? <Text style={styles.messageLive}>LIVE</Text> : null}</View>
              <TextInput accessibilityLabel="Stage message" editable={editControlsEnabled} maxLength={1_980} multiline onChangeText={setMessage} placeholder="Send a message to confidence displays" placeholderTextColor={colors.textFaint} style={styles.messageInput} value={message} />
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: messagePriority, disabled: !editControlsEnabled }} disabled={!editControlsEnabled} onPress={() => setMessagePriority((current) => !current)} style={[styles.priorityToggle, messagePriority && styles.priorityToggleActive]}><View style={[styles.priorityDot, messagePriority && styles.priorityDotActive]} /><View style={styles.priorityCopy}><Text style={[styles.priorityTitle, messagePriority && styles.priorityTitleActive]}>Priority message</Text><Text style={styles.priorityHint}>Use the urgent treatment on confidence displays.</Text></View></Pressable>
              <View style={styles.messageActions}><AppButton disabled={!editControlsEnabled || !message.trim()} label="Send message" onPress={() => relay.sendCommand("stage-message", { message: `${messagePriority ? "!!PRIORITY!!" : ""}${message.trim()}` })} style={styles.messageButton} /><Pressable accessibilityRole="button" disabled={!editControlsEnabled || !relay.stageMessage} onPress={() => relay.sendCommand("stage-clear")} style={[styles.clearMessage, (!editControlsEnabled || !relay.stageMessage) && styles.disabled]}><Text style={styles.clearMessageText}>Clear</Text></Pressable></View>
            </View> : relay.stageMessage ? <View style={[styles.activeMessage, stageMessagePriority && styles.activeMessagePriority]}><Send color={stageMessagePriority ? colors.red : colors.amberText} size={16} /><Text style={[styles.activeMessageText, stageMessagePriority && styles.activeMessagePriorityText]}>{displayStageMessage}</Text></View> : null}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>RUNDOWN</Text>
              <View style={styles.sectionActions}><Text style={styles.sectionCount}>{items.length} ITEMS</Text><Pressable accessibilityLabel="Export rundown" accessibilityRole="button" onPress={() => Alert.alert("Export rundown", "Choose a shareable format.", [{ text: "Cancel", style: "cancel" }, { text: "CSV", onPress: () => exportRundown("csv") }, { text: "PDF", onPress: () => exportRundown("pdf") }])} style={styles.templateButton}><Share2 color={colors.textMuted} size={16} /></Pressable>{canEdit ? <><Pressable accessibilityLabel="Open rundown templates" accessibilityRole="button" onPress={() => setTemplatesOpen(true)} style={styles.templateButton}><Files color={colors.textMuted} size={16} /></Pressable>{items.length > 0 ? <Pressable accessibilityLabel="Clear rundown" accessibilityRole="button" disabled={!editControlsEnabled} onPress={() => Alert.alert("Clear this rundown?", "Every item will be removed for all operators. Save a template first if you may need it again.", [{ text: "Keep rundown", style: "cancel" }, { text: "Clear all", style: "destructive", onPress: () => relay.sendCommand("clear-all") }])} style={[styles.templateButton, !editControlsEnabled && styles.disabled]}><Trash2 color={colors.red} size={16} /></Pressable> : null}<Pressable accessibilityLabel="Add rundown item" accessibilityRole="button" disabled={!editControlsEnabled} onPress={() => setEditor({ item: null, index: items.length })} style={[styles.addItem, !editControlsEnabled && styles.disabled]}><Plus color={colors.black} size={16} /><Text style={styles.addItemText}>Add</Text></Pressable></> : null}</View>
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
                <Text style={styles.headerTitle}>{item.title}</Text>
              ) : (
                <>
                  <View style={[styles.itemIndex, active && styles.itemIndexActive]}><Text style={[styles.itemIndexText, active && styles.itemIndexTextActive]}>{index + 1}</Text></View>
                  <View style={styles.itemCopy}>
                    <Text numberOfLines={2} style={[styles.itemTitle, active && styles.itemTitleActive]}>{item.title}</Text>
                    <Text style={styles.itemMeta}>{formatTimer(item.duration)}{item.assignee ? `  ·  ${item.assignee}` : ""}</Text>
                  </View>
                  {active ? <View style={styles.activeBars}><View style={styles.bar} /><View style={styles.barTall} /><View style={styles.bar} /></View> : item.hardStop ? <Clock3 size={16} color={colors.red} /> : null}
                </>
              )}
              </Pressable>
              {canEdit ? <Pressable accessibilityLabel={`Edit ${item.title}`} accessibilityRole="button" disabled={!editControlsEnabled} onPress={() => setEditor({ item, index })} style={[styles.editItem, !editControlsEnabled && styles.disabled]}><Pencil color={colors.textMuted} size={16} /></Pressable> : null}
            </View>
          );
        }}
        windowSize={7}
      />
      {editor ? <RundownItemSheet index={editor.index} item={editor.item} itemCount={items.length} onClose={() => setEditor(null)} onDelete={deleteItem} onMove={moveItem} onSave={saveItem} /> : null}
      {templatesOpen ? <RundownTemplateSheet
        loading={templatesQuery.isPending}
        onClose={() => setTemplatesOpen(false)}
        onDelete={async (template) => {
          await deleteMobileRundownTemplate({ orgId, showId: detail.show.id, templateId: template.id });
          await templatesQuery.refetch();
        }}
        onLoad={async (template, requestId) => {
          if (!editControlsEnabled) throw new Error("Reconnect live sync before replacing this rundown.");
          await loadMobileRundownTemplate({
            orgId,
            showId: detail.show.id,
            templateId: template.id,
            requestId,
            expectedRevision: relay.revision,
          });
          setTemplatesOpen(false);
        }}
        onLoadPrevious={async (show, requestId) => {
          if (!editControlsEnabled) throw new Error("Reconnect live sync before replacing this rundown.");
          await loadMobilePreviousRundown({
            orgId,
            showId: detail.show.id,
            sourceShowId: show.id,
            requestId,
            expectedRevision: relay.revision,
          });
          setTemplatesOpen(false);
        }}
        onSave={async (name, requestId) => {
          await saveMobileRundownTemplate({ orgId, showId: detail.show.id, requestId, name });
          await templatesQuery.refetch();
        }}
        previousShows={templatesQuery.data?.previousShows ?? []}
        templates={templatesQuery.data?.templates ?? []}
      /> : null}
      {showDetailsOpen ? <RundownShowSheet
        location={relay.location ?? detail.show.location}
        name={showTitle}
        onClose={() => setShowDetailsOpen(false)}
        onSave={async (draft) => {
          if (!editControlsEnabled) throw new Error("Reconnect live sync before changing show details.");
          await updateMobileRundownMeta({
            orgId,
            showId: detail.show.id,
            expectedRevision: relay.revision,
            ...draft,
          });
        }}
        scheduledStartTime={relay.scheduledStartTime === undefined
          ? detail.show.scheduledStartTime
          : relay.scheduledStartTime}
        timeZone={detail.timeZone}
      /> : null}
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
    queryKey: ["mobile-rundown", organization?.id, showId],
    queryFn: () => getMobileRundown(organization!.id, showId),
    enabled: Boolean(organization?.id && showId),
  });

  if (sessionPending || organizationPending || query.isPending) {
    return <Page><ActivityIndicator style={styles.loading} color={colors.amber} size="large" /></Page>;
  }
  if (!session) return <Redirect href="/sign-in" />;
  if (!organization) return <Redirect href="/organizations" />;
  if (query.error || !query.data) {
    return (
      <Page eyebrow="RUNDOWN" title="Could not open show">
        <Text style={styles.syncError}>{query.error?.message ?? "The show is unavailable."}</Text>
        <AppButton label="Try again" onPress={() => query.refetch()} />
      </Page>
    );
  }
  return <RundownContent key={query.data.show.id} detail={query.data} orgId={organization.id} orgSlug={organization.slug} />;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  loading: { marginTop: 80 },
  connectionRow: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 8, marginTop: -12 },
  connectionText: { flex: 1, color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "700" },
  connected: { color: colors.green },
  permissionBadge: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, paddingHorizontal: 9, paddingVertical: 5 },
  permissionText: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  connectionAction: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 17, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  timerCard: { alignItems: "center", gap: 10, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.large },
  timerCardOvertime: { borderColor: colors.redStrongBorder, backgroundColor: colors.redSoft },
  nowRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  liveDotIdle: { backgroundColor: colors.textFaint },
  nowLabel: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.8 },
  currentTitle: { minHeight: 24, color: colors.text, fontFamily, fontSize: 18, lineHeight: 24, fontWeight: "700", textAlign: "center" },
  timer: { width: "100%", color: colors.amberText, fontFamily: "monospace", fontSize: 66, lineHeight: 74, fontWeight: "800", letterSpacing: -4, textAlign: "center" },
  timerOvertime: { color: colors.red },
  timerMode: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "800", letterSpacing: 1.5 },
  modeRow: { width: "100%", flexDirection: "row", gap: 7 },
  modeChoice: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised },
  modeChoiceActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  modeChoiceText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "700" },
  modeChoiceTextActive: { color: colors.amberText },
  transport: { width: "100%", flexDirection: "row", gap: 10, marginTop: 10 },
  control: { flex: 1, minHeight: 67, alignItems: "center", justifyContent: "center", gap: 5, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong },
  controlPrimary: { backgroundColor: colors.amber, borderColor: colors.amber },
  controlLabel: { color: colors.text, fontFamily, fontSize: 10, fontWeight: "700" },
  controlLabelPrimary: { color: colors.black },
  adjustRow: { width: "100%", flexDirection: "row", gap: 8 },
  customAdjustRow: { width: "100%", flexDirection: "row", gap: 8 },
  customAdjustInput: { flex: 0.8, minHeight: 40, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, color: colors.text, fontFamily: "monospace", fontSize: 13, textAlign: "center", paddingHorizontal: 8 },
  miniButton: { flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised },
  miniLabel: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "700" },
  observerCopy: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", marginTop: 8 },
  syncError: { color: colors.red, fontFamily, fontSize: 13, lineHeight: 19 },
  ppCard: { gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 13 },
  ppHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  ppTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  ppTitle: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  ppStatus: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  ppStatusConnected: { color: colors.green },
  ppPreview: { gap: 5, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 11 },
  ppPresentation: { color: colors.amberText, fontFamily, fontSize: 10, fontWeight: "800" },
  ppText: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20 },
  ppNotes: { color: colors.textFaint, fontFamily, fontSize: 11, lineHeight: 16 },
  ppEmpty: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  ppStageToggle: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 10 },
  ppStageToggleActive: { borderColor: colors.greenBorder, backgroundColor: colors.greenSoft },
  ppStageCopy: { flex: 1, minWidth: 0, gap: 2 },
  ppStageTitle: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  ppStageHint: { color: colors.textFaint, fontFamily, fontSize: 10, lineHeight: 15 },
  ppWarning: { color: colors.amberText, fontFamily, fontSize: 11, lineHeight: 17 },
  ppControls: { flexDirection: "row", gap: 8 },
  messageCard: { gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 13 },
  messageHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  messageTitle: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  messageLive: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  messageInput: { minHeight: 72, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 14, lineHeight: 20, padding: 11, textAlignVertical: "top" },
  messageActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  priorityToggle: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.small, borderWidth: 1, borderColor: colors.borderSoft, padding: 10 },
  priorityToggleActive: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  priorityDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: colors.textFaint },
  priorityDotActive: { borderColor: colors.red, backgroundColor: colors.red },
  priorityCopy: { flex: 1, minWidth: 0, gap: 2 },
  priorityTitle: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "800" },
  priorityTitleActive: { color: colors.red },
  priorityHint: { color: colors.textFaint, fontFamily, fontSize: 10, lineHeight: 15 },
  messageButton: { flex: 1, minHeight: 44 },
  clearMessage: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 16 },
  clearMessageText: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "700" },
  activeMessage: { flexDirection: "row", alignItems: "flex-start", gap: 9, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft, padding: 12 },
  activeMessageText: { flex: 1, color: colors.amberText, fontFamily, fontSize: 13, lineHeight: 19 },
  activeMessagePriority: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  activeMessagePriorityText: { color: colors.red },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 10, fontWeight: "900", letterSpacing: 1.6 },
  sectionCount: { color: colors.textFaint, fontFamily, fontSize: 9, fontWeight: "700", letterSpacing: 1 },
  sectionActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  addItem: { minHeight: 36, flexDirection: "row", alignItems: "center", gap: 5, borderRadius: radii.pill, backgroundColor: colors.amber, paddingHorizontal: 12 },
  addItemText: { color: colors.black, fontFamily, fontSize: 11, fontWeight: "800" },
  templateButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
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
