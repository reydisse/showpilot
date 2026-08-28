import { useState } from "react";
import FilePlus from "lucide-react-native/icons/file-plus";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { AppField } from "@/components/app-field";
import { Page } from "@/components/page";
import type { MobilePreviousRundown, MobileRundownTemplate } from "@/lib/mobile-api";
import { createLocalRequestId } from "@/lib/request-id";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export function RundownTemplateSheet({
  loading,
  onClose,
  onDelete,
  onLoad,
  onLoadPrevious,
  onSave,
  templates,
  previousShows,
}: {
  loading: boolean;
  onClose: () => void;
  onDelete: (template: MobileRundownTemplate) => Promise<void>;
  onLoad: (template: MobileRundownTemplate, requestId: string) => Promise<void>;
  onLoadPrevious: (show: MobilePreviousRundown, requestId: string) => Promise<void>;
  onSave: (name: string, requestId: string) => Promise<void>;
  templates: MobileRundownTemplate[];
  previousShows: MobilePreviousRundown[];
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [name, setName] = useState("");
  const [saveRequestId, setSaveRequestId] = useState(() => createLocalRequestId("rundown-template"));
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    try {
      await action();
    } catch (error) {
      Alert.alert("Template action failed", error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusyId(null);
    }
  }

  return <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
    <Page scroll={false}>
      <View style={styles.header}>
        <View style={styles.headerCopy}><Text style={styles.eyebrow}>RUNDOWN TEMPLATES</Text><Text style={styles.heading}>Reuse a complete show</Text></View>
        <Pressable accessibilityLabel="Close rundown templates" accessibilityRole="button" onPress={onClose} style={styles.close}><X color={colors.textMuted} size={21} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.saveCard}>
          <View style={styles.saveHeading}><FilePlus color={colors.amberText} size={19} /><View style={styles.saveCopy}><Text style={styles.saveTitle}>Save current rundown</Text><Text style={styles.saveHint}>Includes the service title, start time, and every item.</Text></View></View>
          <AppField autoCapitalize="sentences" label="Template name" maxLength={200} onChangeText={setName} placeholder="Sunday morning standard" value={name} />
          <AppButton disabled={!name.trim() || busyId !== null} label={busyId === "save" ? "Saving template…" : "Save template"} loading={busyId === "save"} onPress={() => run("save", async () => {
            await onSave(name.trim(), saveRequestId);
            setName("");
            setSaveRequestId(createLocalRequestId("rundown-template"));
          })} />
        </View>

        {previousShows.length > 0 ? <>
          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>PREVIOUS SHOWS</Text><Text style={styles.sectionCount}>{previousShows.length}</Text></View>
          {previousShows.slice(0, 20).map((show) => <View key={show.id} style={styles.templateCard}>
            <View style={styles.templateCopy}><Text style={styles.templateName}>{show.name || "Untitled show"}</Text><Text style={styles.templateMeta}>{show.serviceDate} · {show.itemCount} item{show.itemCount === 1 ? "" : "s"}{show.location ? ` · ${show.location}` : ""}</Text></View>
            <Pressable accessibilityRole="button" disabled={busyId !== null} onPress={() => Alert.alert("Replace current rundown?", `Copy the rundown and show details from ${show.serviceDate}?`, [{ text: "Cancel", style: "cancel" }, { text: "Load previous", onPress: () => void run(show.id, async () => onLoadPrevious(show, createLocalRequestId("previous-load"))) }])} style={[styles.loadButton, busyId !== null && styles.disabled]}><Text style={styles.loadText}>{busyId === show.id ? "Loading…" : "Load previous"}</Text></Pressable>
          </View>)}
        </> : null}

        <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>SAVED TEMPLATES</Text><Text style={styles.sectionCount}>{templates.length}</Text></View>
        {loading ? <ActivityIndicator color={colors.amber} size="large" /> : templates.length === 0 ? <Text style={styles.empty}>No saved templates yet. Save the current rundown to create one.</Text> : templates.map((template) => <View key={template.id} style={styles.templateCard}>
          <View style={styles.templateCopy}><Text style={styles.templateName}>{template.name}</Text><Text style={styles.templateMeta}>{template.itemCount} item{template.itemCount === 1 ? "" : "s"}{template.serviceName ? ` · ${template.serviceName}` : ""}{template.scheduledStartTime ? ` · ${template.scheduledStartTime}` : ""}</Text><Text style={styles.templateDate}>Saved {new Date(template.updatedAt).toLocaleDateString()}</Text></View>
          <View style={styles.templateActions}>
            <Pressable accessibilityRole="button" disabled={busyId !== null} onPress={() => Alert.alert("Replace current rundown?", `Load “${template.name}” into this show? This replaces every current item.`, [{ text: "Cancel", style: "cancel" }, { text: "Load template", onPress: () => void run(template.id, async () => onLoad(template, createLocalRequestId("template-load"))) }])} style={[styles.loadButton, busyId !== null && styles.disabled]}><Text style={styles.loadText}>{busyId === template.id ? "Loading…" : "Load"}</Text></Pressable>
            <Pressable accessibilityLabel={`Delete ${template.name}`} accessibilityRole="button" disabled={busyId !== null} onPress={() => Alert.alert("Delete template?", `Delete “${template.name}”? Existing shows are not affected.`, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => void run(`delete-${template.id}`, async () => onDelete(template)) }])} style={[styles.deleteButton, busyId !== null && styles.disabled]}><Trash2 color={colors.red} size={17} /></Pressable>
          </View>
        </View>)}
      </ScrollView>
    </Page>
  </Modal>;
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: spacing.medium, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0, gap: 5 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  heading: { color: colors.text, fontFamily, fontSize: 22, lineHeight: 28, fontWeight: "800" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.large, paddingVertical: spacing.large, paddingBottom: 60 },
  saveCard: { gap: spacing.medium, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  saveHeading: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  saveCopy: { flex: 1, minWidth: 0, gap: 4 },
  saveTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  saveHint: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.4 },
  sectionCount: { color: colors.textFaint, fontFamily, fontSize: 11, fontWeight: "800" },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  templateCard: { gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 14 },
  templateCopy: { gap: 5 },
  templateName: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  templateMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  templateDate: { color: colors.textFaint, fontFamily, fontSize: 11 },
  templateActions: { flexDirection: "row", gap: 8 },
  loadButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, backgroundColor: colors.amber },
  loadText: { color: colors.black, fontFamily, fontSize: 12, fontWeight: "800" },
  deleteButton: { width: 46, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  disabled: { opacity: 0.4 },
}));
