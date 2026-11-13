import { useState } from "react";
import ArrowDown from "lucide-react-native/icons/arrow-down";
import ArrowUp from "lucide-react-native/icons/arrow-up";
import Check from "lucide-react-native/icons/check";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import type { RundownItem } from "@/lib/mobile-api";
import { createLocalRequestId } from "@/lib/request-id";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

const ITEM_TYPES = [
  ["segment", "Segment"],
  ["song", "Song"],
  ["header", "Section"],
  ["prayer", "Prayer"],
  ["announcement", "Announcement"],
  ["offering", "Offering"],
  ["custom", "Custom"],
] as const;

function durationInput(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function parseRundownDuration(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  // Colon-separated components are clock fields, so seconds (and minutes in
  // H:MM:SS) must remain within their normal ranges. This prevents inputs
  // such as 1:99 from silently becoming 2:39.
  if (parts.length >= 2 && numbers.at(-1)! >= 60) return null;
  if (parts.length === 3 && numbers[1] >= 60) return null;
  const seconds = parts.length === 3
    ? numbers[0] * 3_600 + numbers[1] * 60 + numbers[2]
    : parts.length === 2
      ? numbers[0] * 60 + numbers[1]
      : numbers[0] * 60;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 7 * 24 * 3_600) return null;
  return seconds * 1_000;
}

export function RundownItemSheet({
  index,
  item,
  itemCount,
  currentItem,
  currentItemId,
  revision,
  canEdit,
  onClose,
  onDelete,
  onMove,
  onSave,
}: {
  index: number;
  item: RundownItem | null;
  itemCount: number;
  currentItem: RundownItem | null;
  currentItemId: string | null;
  revision: number;
  canEdit: boolean;
  onClose: () => void;
  onDelete: (item: RundownItem, revision: number) => void;
  onMove: (item: RundownItem, direction: "up" | "down") => void;
  onSave: (item: RundownItem) => void;
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [id] = useState(() => item?.id ?? createLocalRequestId("rundown-item"));
  const [title, setTitle] = useState(item?.title ?? "");
  const [type, setType] = useState(item?.type ?? "segment");
  const [duration, setDuration] = useState(() => durationInput(item?.duration ?? 300_000));
  const [assignee, setAssignee] = useState(item?.assignee ?? "");
  const [cue, setCue] = useState(item?.cue ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [hardStop, setHardStop] = useState(item?.hardStop ?? false);
  const [removal, setRemoval] = useState<{ item: RundownItem; revision: number; active: boolean } | null>(null);
  function reviewRemoval() {
    if (canEdit && currentItem) setRemoval({ item: currentItem, revision, active: currentItem.id === currentItemId });
  }
  const durationMs = parseRundownDuration(duration);
  const valid = title.trim().length > 0 && durationMs !== null;

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <Page scroll={false}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{item ? "EDIT RUNDOWN ITEM" : "NEW RUNDOWN ITEM"}</Text>
            <Text style={styles.heading}>{item?.title || "Add to the show"}</Text>
          </View>
          <Pressable accessibilityLabel="Close rundown item editor" accessibilityRole="button" onPress={onClose} style={styles.close}>
            <X color={colors.textMuted} size={21} />
          </Pressable>
        </View>
        <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <AppField autoCapitalize="sentences" label="Title" maxLength={500} onChangeText={setTitle} placeholder="Welcome and opening" value={title} />
          <View style={styles.group}>
            <Text style={styles.label}>Item type</Text>
            <View accessibilityRole="radiogroup" style={styles.typeGrid}>
              {ITEM_TYPES.map(([value, label]) => {
                const selected = type === value;
                return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} key={value} onPress={() => setType(value)} style={[styles.typeChoice, selected && styles.typeChoiceActive]}><Text style={[styles.typeText, selected && styles.typeTextActive]}>{label}</Text>{selected ? <Check color={colors.amberText} size={14} /> : null}</Pressable>;
              })}
            </View>
          </View>
          {type !== "header" ? <AppField autoCapitalize="none" error={duration && durationMs === null ? "Use minutes, M:SS, or H:MM:SS." : undefined} keyboardType="numbers-and-punctuation" label="Assigned duration" maxLength={10} onChangeText={setDuration} placeholder="5:00" value={duration} /> : null}
          <AppField autoCapitalize="words" label="Assignee" maxLength={500} onChangeText={setAssignee} placeholder="Host or department" value={assignee} />
          <AppField autoCapitalize="characters" label="Cue" maxLength={2_000} onChangeText={setCue} placeholder="GO when music resolves" value={cue} />
          <AppField autoCapitalize="sentences" label="Notes" maxLength={20_000} multiline onChangeText={setNotes} placeholder="Operator notes visible with this item" style={styles.notesInput} value={notes} />
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}><Text style={styles.switchTitle}>Hard stop</Text><Text style={styles.switchHint}>Flag this item as a timing boundary.</Text></View>
            <Switch accessibilityLabel="Hard stop" onValueChange={setHardStop} thumbColor={hardStop ? colors.amber : colors.textMuted} trackColor={{ false: colors.border, true: colors.amberSoft }} value={hardStop} />
          </View>
          {item ? <View style={styles.itemActions}>
            <Pressable accessibilityLabel="Move rundown item up" accessibilityRole="button" disabled={!canEdit || Boolean(removal) || index <= 0} onPress={() => onMove(item, "up")} style={[styles.itemAction, (!canEdit || Boolean(removal) || index <= 0) && styles.disabled]}><ArrowUp color={colors.textMuted} size={18} /><Text style={styles.itemActionText}>Move up</Text></Pressable>
            <Pressable accessibilityLabel="Move rundown item down" accessibilityRole="button" disabled={!canEdit || Boolean(removal) || index >= itemCount - 1} onPress={() => onMove(item, "down")} style={[styles.itemAction, (!canEdit || Boolean(removal) || index >= itemCount - 1) && styles.disabled]}><ArrowDown color={colors.textMuted} size={18} /><Text style={styles.itemActionText}>Move down</Text></Pressable>
            <Pressable accessibilityLabel="Delete rundown item" accessibilityRole="button" disabled={!canEdit || !currentItem} onPress={reviewRemoval} style={[styles.itemAction, styles.deleteAction, (!canEdit || !currentItem) && styles.disabled]}><Trash2 color={colors.red} size={18} /><Text style={[styles.itemActionText, styles.deleteText]}>Delete</Text></Pressable>
          </View> : null}
          {removal ? <View style={styles.group}>
            <Text style={styles.switchTitle}>Remove “{removal.item.title}” from this show?</Text>
            <Text style={styles.switchHint}>{removal.active ? "This is the current item. Removing it stops its timer for all operators. Undo restores the item but does not restart it." : "This removes only this item for all operators. Undo is available briefly after removal."}</Text>
            {!currentItem ? <Text accessibilityRole="alert" style={styles.deleteText}>This item is no longer in the rundown.</Text> : revision !== removal.revision ? <>
              <Text accessibilityRole="alert" style={styles.deleteText}>The rundown changed. Review the current item before removing it.</Text>
              <AppButton label="Review current item" variant="secondary" disabled={!canEdit} onPress={reviewRemoval}/>
            </> : null}
            {!canEdit ? <Text accessibilityRole="alert" style={styles.deleteText}>Reconnect with editing access before removing an item.</Text> : null}
            <AppButton label="Keep item" variant="secondary" onPress={() => setRemoval(null)}/>
            <AppButton label="Confirm item removal" variant="danger" disabled={!canEdit || !currentItem || revision !== removal.revision} onPress={() => {
              if (!canEdit || !currentItem || revision !== removal.revision) return;
              onDelete(removal.item, removal.revision);
              setRemoval(null);
            }}/>
          </View> : null}
          <AppButton disabled={!valid || !canEdit || Boolean(removal)} label={item ? "Save item" : "Add item"} onPress={() => {
            if (durationMs === null) return;
            onSave({
              ...(item ?? {}),
              id,
              title: title.trim(),
              type,
              duration: type === "header" ? 0 : durationMs,
              notes: notes.trim(),
              assignee: assignee.trim(),
              cue: cue.trim(),
              status: item?.status ?? "upcoming",
              sortOrder: item?.sortOrder ?? itemCount,
              revision: item?.revision ?? 0,
              hardStop,
            });
            onClose();
          }} />
        </ScrollView>
      </Page>
    </Modal>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: spacing.medium, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0, gap: 5 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  heading: { color: colors.text, fontFamily, fontSize: 22, lineHeight: 28, fontWeight: "800" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.large, paddingVertical: spacing.large, paddingBottom: 60 },
  group: { gap: 8 },
  label: { color: colors.textMuted, fontFamily, fontSize: 13, fontWeight: "600" },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  typeChoice: { minHeight: 42, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 13 },
  typeChoiceActive: { borderColor: colors.amberStrongBorder, backgroundColor: colors.amberSoft },
  typeText: { color: colors.textMuted, fontFamily, fontSize: 12, fontWeight: "700" },
  typeTextActive: { color: colors.amberText },
  notesInput: { minHeight: 110, paddingTop: 14, textAlignVertical: "top" },
  switchRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 14, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 14 },
  switchCopy: { flex: 1, minWidth: 0, gap: 4 },
  switchTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "700" },
  switchHint: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 17 },
  itemActions: { flexDirection: "row", gap: 8 },
  itemAction: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center", gap: 4, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  itemActionText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700" },
  deleteAction: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  deleteText: { color: colors.red },
  disabled: { opacity: 0.35 },
}));
