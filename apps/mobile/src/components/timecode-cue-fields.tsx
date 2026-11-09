import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { AUTOMATION_ACTIONS, normalizeActionParams, parseTimecodeString } from "@showpilot/shared";
import { AppField } from "./app-field";
import { AppButton } from "./app-button";
import { CueChoice } from "./cue-choice";
import { OperationsError } from "./operations-ui";
import { useCueChoices } from "../hooks/use-cue-choices";
import { cueFields, cueFieldText, structuredCuePayload, cueDeviceParams } from "../lib/timecode-cue-fields";
import { numericCueField, type TimecodeCueDraft } from "../lib/timecode-cue-recovery";
import { getMobileCueDevices, getMobileCueSongs, getMobileCueSections, getMobileCueMedia, getMobileRundown, getMobileDeviceControlState } from "../lib/mobile-api";
import { createThemedStyles, fontFamily } from "../theme/tokens";
type Scope = { orgId: string; userId: string; showId: string };
type FieldsProps = { scope: Scope; action: string; payload: Record<string, unknown>; disabled: boolean;
  update: (payload: Record<string, unknown>) => void; ready: (ready: boolean) => void };
const text = (value: unknown) => typeof value === "string" ? value : "";
function parsePayload(value: string): Record<string, unknown> {
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(value)); } catch { return {}; }
}
function ChoiceStatus({ query, noun }: { query: { isFetching: boolean; error: Error | null; refetch: () => unknown }; noun: string }) {
  const styles = useStyles();
  return <View style={styles.group}>
    {query.isFetching ? <Text style={styles.text}>Loading {noun}…</Text> : null}
    {query.error ? <OperationsError message={query.error.message} /> : null}
    <AppButton label={`${query.error ? "Retry loading" : "Refresh"} ${noun}`} disabled={query.isFetching} variant="secondary" onPress={() => void query.refetch()} />
  </View>;
}
export function TimecodeCueFields({ scope, draft, update, disabled, editing = false, changeDetails = true, onValid }: {
  scope: Scope; draft: TimecodeCueDraft; update: (changes: Partial<Pick<TimecodeCueDraft, "label" | "timecode" | "action" | "payload" | "tolerance" | "lead">>) => void;
  disabled: boolean; editing?: boolean; changeDetails?: boolean; onValid: (valid: boolean) => void;
}) {
  const styles = useStyles();
  const payload = parsePayload(draft.payload);
  const [selection, setSelection] = useState<{ action: string; ready: boolean }>({ action: draft.action, ready: false });
  const complex = ["device-action", "lighting-scene", "lighting-blackout", "rundown-goto-item", "rundown-start-item", "lyrics-goto", "pp-trigger-slide", "media-play"].includes(draft.action);
  const format = draft.format;
  const timeError = format && parseTimecodeString(draft.timecode.trim(), format) ? null : `Enter a valid cue time for ${format ? `${format.frameRate} fps ${format.dropFrame.toUpperCase()}` : "the current format"}.`;
  let fieldError: string | null = null;
  try {
    numericCueField(draft.tolerance ?? "5", 9000, "Tolerance"); numericCueField(draft.lead ?? "0", 60000, "Cue lead");
    if (changeDetails) structuredCuePayload(draft.action, payload);
  } catch (error) { fieldError = error instanceof Error ? error.message : "Review the cue fields."; }
  const valid = !timeError && !fieldError && Boolean(draft.label.trim()) && draft.label.trim().length <= 200
    && (!changeDetails || !complex || selection.action === draft.action && selection.ready);
  useEffect(() => onValid(valid), [valid, onValid]);
  const change = (next: Record<string, unknown>) => update({ payload: JSON.stringify(next) });
  const props: FieldsProps = { scope, action: draft.action, payload, disabled, update: change, ready: ready => setSelection(previous => previous.action === draft.action && previous.ready === ready ? previous : { action: draft.action, ready }) };
  return <View style={styles.group}>
    <AppField label="Event label" autoFocus={editing} value={draft.label} maxLength={200} editable={!disabled} onChangeText={label => update({ label })} />
    <AppField label="Trigger timecode" value={draft.timecode} editable={!disabled} onChangeText={timecode => update({ timecode })} error={timeError ?? undefined} />
    <Text style={styles.text}>{format ? `${format.frameRate} fps ${format.dropFrame.toUpperCase()}` : "Load the current frame rate before saving."}</Text>
    {editing ? <Text style={styles.text}>Action: {AUTOMATION_ACTIONS.find(option => option.value === draft.action)?.label ?? draft.action}</Text>
      : <CueChoice label="Action" value={draft.action} options={[...AUTOMATION_ACTIONS]} disabled={disabled} onChange={action => update({ action, payload: "{}" })} />}
    <AppField label="Tolerance (frames)" value={draft.tolerance ?? "5"} keyboardType="numeric" editable={!disabled} onChangeText={tolerance => update({ tolerance })} />
    <Text style={styles.text}>Used only for startup and resync matching. Forward playback fires when the clock crosses the cue.</Text>
    <AppField label="Cue lead (ms)" value={draft.lead ?? "0"} keyboardType="numeric" editable={!disabled} onChangeText={lead => update({ lead })} />
    <Text style={styles.text}>Send early by this amount, plus saved device latency. The cue time stays unchanged.</Text>
    {changeDetails ? <>
      {draft.action === "device-action" || draft.action === "lighting-scene" || draft.action === "lighting-blackout" ? <DeviceFields key={draft.action} {...props} /> : null}
      {draft.action === "lyrics-goto" || draft.action === "pp-trigger-slide" ? <SongFields key={draft.action} {...props} /> : null}
      {draft.action === "rundown-goto-item" || draft.action === "rundown-start-item" ? <RundownFields key={draft.action} {...props} /> : null}
      {draft.action === "media-play" ? <MediaFields {...props} /> : null}
      {draft.action === "lower-third-show" ? <>
        <CueChoice label="Lower third type" value={text(payload.type) || "freetext"} options={[{ value: "freetext", label: "Free text" }, { value: "person", label: "Person" }, { value: "scripture", label: "Scripture" }, { value: "style", label: "Style only" }]} disabled={disabled} onChange={type => change({ type, style: payload.style ?? "default" })} />
        <CueChoice label="Lower third style" value={text(payload.style) || "default"} options={[{ value: "default", label: "Default" }, { value: "minimal", label: "Minimal" }, { value: "scripture", label: "Scripture" }, ...(!["default", "minimal", "scripture"].includes(text(payload.style)) && text(payload.style) ? [{ value: text(payload.style), label: text(payload.style) }] : [])]} disabled={disabled} onChange={style => change({ ...payload, style })} />
      </> : null}
      {cueFields(draft.action, payload).map(field => <AppField key={field.key} label={field.label} value={cueFieldText(field, payload[field.key])} editable={!disabled}
        maxLength={field.maxLength ?? 2000} multiline={field.kind === "multiline"} onChangeText={value => change({ ...payload, [field.key]: value })} />)}
      {!complex && !cueFields(draft.action, payload).length && draft.action !== "lower-third-show" ? <Text style={styles.text}>No additional action details are needed.</Text> : null}
    </> : <Text style={styles.text}>Saved action details are preserved. Editing does not fire or re-arm this cue.</Text>}
    {fieldError ? <OperationsError message={fieldError} /> : null}
  </View>;
}
function DeviceFields({ scope, action, payload, update, ready, disabled }: FieldsProps) {
  const styles = useStyles();
  const query = useCueChoices([scope.userId, scope.orgId, "devices"], signal => getMobileCueDevices(scope.orgId, signal));
  const devices = (query.data ?? []).filter(device => action === "device-action" || device.category === "lighting");
  const device = devices.find(device => device.id === payload.deviceId);
  const dynamic = useCueChoices([scope.userId, scope.orgId, "device-actions", device?.id ?? ""], async () => {
    const state = await getMobileDeviceControlState({ orgId: scope.orgId, deviceId: device?.id ?? "" });
    if (!state.connected) throw new Error("Connect this Home Assistant device before choosing an action.");
    return state.controls;
  }, device?.actionSource === "homeassistant");
  const actions = (device?.actionSource === "static" ? device.actions : dynamic.data ?? []).filter(option => action === "lighting-scene" ? option.id === "recall_scene" : action === "lighting-blackout" ? option.id === "blackout" : true);
  const selected = actions.find(option => option.id === (action === "lighting-blackout" ? "blackout" : payload.actionId));
  const params = cueDeviceParams(payload);
  let error: string | null = null;
  if (selected) try {
    for (const field of selected.params) if (field.type === "number" && params[field.id] === "") throw new Error(`${field.label} is required.`);
    normalizeActionParams(selected, params);
  } catch (cause) { error = cause instanceof Error ? cause.message : "Review device parameters."; }
  const valid = query.isSuccess && !query.isFetching && Boolean(device && selected) && !error && (device?.actionSource !== "homeassistant" || dynamic.isSuccess && !dynamic.isFetching);
  useEffect(() => ready(valid), [valid, ready]);
  return <View style={styles.group}>
    <CueChoice label={action === "device-action" ? "Device" : "Lighting device"} value={text(payload.deviceId)} options={devices.map(item => ({ value: item.id, label: item.label }))} disabled={disabled || query.isFetching || query.isError}
      onChange={deviceId => update({ deviceId })} />
    {device && action !== "lighting-blackout" ? <CueChoice label="Device action" value={text(payload.actionId)} options={actions.map(item => ({ value: item.id, label: item.label }))} disabled={disabled || query.isFetching || query.isError || device.actionSource === "homeassistant" && (dynamic.isFetching || dynamic.isError)}
      onChange={actionId => update({ deviceId: device.id, actionId, params: Object.fromEntries((actions.find(item => item.id === actionId)?.params ?? []).filter(field => field.default !== undefined || field.type === "boolean").map(field => [field.id, field.default ?? false])) })} /> : null}
    {selected?.params.map(field => {
      const values = params, value = values[field.id] ?? field.default;
      const change = (value: unknown) => update({ ...payload, params: { ...values, [field.id]: value } });
      return field.type === "select" ? <CueChoice key={field.id} label={field.label} value={text(value)} options={field.options ?? []} disabled={disabled} onChange={change} />
        : field.type === "boolean" ? <AppButton key={field.id} label={`${field.label}: ${value === true ? "On" : "Off"}`} disabled={disabled} variant="secondary" onPress={() => change(value !== true)} />
        : <AppField key={field.id} label={field.label} value={typeof value === "string" || typeof value === "number" ? String(value) : ""} editable={!disabled} onChangeText={change} />;
    })}
    {error ? <OperationsError message={error} /> : null}
    {!query.isFetching && query.isSuccess && !devices.length ? <Text style={styles.text}>Add an enabled device with supported actions in Devices first.</Text> : null}
    {device && !selected && !actions.length ? <Text style={styles.text}>This device has no available action for this cue.</Text> : null}
    <ChoiceStatus query={query} noun="devices" />
    {device?.actionSource === "homeassistant" ? <ChoiceStatus query={dynamic} noun="device actions" /> : null}
  </View>;
}
function SongFields({ scope, action, payload, update, ready, disabled }: FieldsProps) {
  const styles = useStyles();
  const query = useCueChoices([scope.userId, scope.orgId, "songs"], signal => getMobileCueSongs(scope.orgId, signal));
  const songs = (query.data ?? []).filter(song => action !== "pp-trigger-slide" || song.ppPresentationUuid);
  const songId = text(payload.songId) || (action === "pp-trigger-slide" ? songs.find(song => song.ppPresentationUuid === payload.presentationUuid)?.id ?? "" : "");
  const sections = useCueChoices([scope.userId, scope.orgId, "sections", songId], signal => getMobileCueSections(scope.orgId, songId, signal), Boolean(songId));
  const song = sections.data;
  const sectionId = text(payload.sectionId) || (action === "pp-trigger-slide" ? song?.sections.find(section => section.sourceSlideIndex === payload.slideIndex)?.id ?? "" : "");
  const section = song?.sections.find(section => section.id === sectionId);
  const valid = query.isSuccess && !query.isFetching && songs.some(song => song.id === songId) && sections.isSuccess && !sections.isFetching && Boolean(section)
    && (action !== "lyrics-goto" || section?.lyrics === payload.lyrics)
    && (action !== "pp-trigger-slide" || Boolean(song?.ppPresentationUuid && section?.sourceSlideIndex != null));
  useEffect(() => ready(valid), [valid, ready]);
  return <View style={styles.group}>
    <CueChoice label={action === "pp-trigger-slide" ? "ProPresenter song" : "Song"} value={songId} options={songs.map(song => ({ value: song.id, label: song.title }))} disabled={disabled || query.isFetching || query.isError}
      onChange={songId => update({ songId, ...(payload.target ? { target: payload.target } : {}) })} />
    {songId ? <><CueChoice label="Section" value={sectionId} options={(song?.sections ?? []).map(section => ({ value: section.id, label: section.label }))} disabled={disabled || sections.isFetching || sections.isError}
      onChange={id => {
        const section = song?.sections.find(section => section.id === id); if (!song || !section) return;
        update(action === "pp-trigger-slide" ? { presentationUuid: song.ppPresentationUuid, slideIndex: section.sourceSlideIndex, ...(payload.target ? { target: payload.target } : {}) }
          : { songId: song.id, songTitle: song.title, sectionId: section.id, sectionLabel: section.label, lyrics: section.lyrics, nextLabel: song.sections[song.sections.indexOf(section) + 1]?.label ?? "" });
      }} />
      {section ? <Text style={styles.text}>{section.lyrics}</Text> : null}
      {section && action === "lyrics-goto" && section.lyrics !== payload.lyrics ? <OperationsError message="This section changed. Choose it again to use its current text." /> : null}
      {section && action === "pp-trigger-slide" && section.sourceSlideIndex == null ? <OperationsError message="This section has no ProPresenter slide. Map it in Songs first." /> : null}
      {sections.isSuccess && !song?.sections.length ? <Text style={styles.text}>Add sections to this song first.</Text> : null}
      <ChoiceStatus query={sections} noun="sections" /></> : null}
    {query.isSuccess && !songs.length ? <Text style={styles.text}>{action === "pp-trigger-slide" ? "Import a ProPresenter song first." : "Create a song with sections first."}</Text> : null}
    <ChoiceStatus query={query} noun="songs" />
  </View>;
}
function RundownFields({ scope, payload, update, ready, disabled }: FieldsProps) {
  const styles = useStyles();
  const query = useCueChoices([scope.userId, scope.orgId, scope.showId, "rundown"], () => getMobileRundown(scope.orgId, scope.showId));
  const items = (query.data?.items ?? []).filter(item => item.type !== "header");
  const valid = query.isSuccess && !query.isFetching && items.some(item => item.id === payload.itemId);
  useEffect(() => ready(valid), [valid, ready]);
  return <View style={styles.group}><CueChoice label="Rundown item" value={text(payload.itemId)} options={items.map(item => ({ value: item.id, label: item.title }))} disabled={disabled || query.isFetching || query.isError} onChange={itemId => update({ itemId })} />
    {query.isSuccess && !items.length ? <Text style={styles.text}>Add playable items to this show’s rundown first.</Text> : null}<ChoiceStatus query={query} noun="rundown items" /></View>;
}
function MediaFields({ scope, payload, update, ready, disabled }: FieldsProps) {
  const styles = useStyles();
  const [cursor, setCursor] = useState<string | null>(null);
  const query = useCueChoices([scope.userId, scope.orgId, "media", cursor ?? ""], signal => getMobileCueMedia(scope.orgId, cursor, signal));
  const assets = query.data?.assets ?? [];
  const valid = query.isSuccess && !query.isFetching && assets.some(asset => asset.id === payload.mediaId && asset.etag === payload.etag);
  useEffect(() => ready(valid), [valid, ready]);
  return <View style={styles.group}><CueChoice label="Media file" value={text(payload.mediaId)} options={assets.map(asset => ({ value: asset.id, label: asset.name }))} disabled={disabled || query.isFetching || query.isError} onChange={id => {
    const asset = assets.find(asset => asset.id === id); if (asset) update({ ...payload, mediaId: asset.id, etag: asset.etag });
  }} />
    {query.isSuccess && !assets.length ? <Text style={styles.text}>Upload a file in the web Media library first.</Text> : null}
    {query.data?.cursor ? <AppButton label="Next media page" disabled={disabled || query.isFetching} variant="secondary" onPress={() => { setCursor(query.data?.cursor ?? null); update({ output: payload.output, volume: payload.volume }); }} /> : null}
    {cursor ? <AppButton label="First media page" disabled={disabled || query.isFetching} variant="secondary" onPress={() => { setCursor(null); update({ output: payload.output, volume: payload.volume }); }} /> : null}
    <ChoiceStatus query={query} noun="media" />
  </View>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({ group: { gap: 12 }, text: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 21 } }));
