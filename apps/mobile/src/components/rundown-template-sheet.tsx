import { useTemplateDelete } from "@/hooks/use-template-delete";
import { TemplateDeleteStatus } from "@/components/template-delete-status";
import { useQueryClient } from "@tanstack/react-query";
import { useScreenFocus } from "@/hooks/use-screen-polling";
import { useRundownReplacement } from "@/hooks/use-rundown-replacement";
import { RundownReplacementForm } from "@/components/rundown-replacement-form";
import { readMobileRundownReplacement,commandMobileRundownReplacement,deleteMobileRundownTemplate } from "@/lib/mobile-api";
import { useEffect, useRef, useState } from "react";
import { TemplateSaveForm } from "@/components/template-save-form";
import type { TemplateCopyInput } from "@/lib/template-save-recovery";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "@/components/app-button";
import { Page } from "@/components/page";
import type { MobilePreviousRundown, MobileRundownTemplate } from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

export function RundownTemplateSheet({
  loading,
  onClose,
  orgId, userId, showId, copy, canCapture, error, refreshing, onRetry,
  templates,
  previousShows,
}: {
  loading: boolean;
  onClose: () => void;
  orgId: string; userId: string; showId: string; copy: TemplateCopyInput; canCapture: boolean; error?: string; refreshing: boolean; onRetry: () => void;
  templates: MobileRundownTemplate[];
  previousShows: MobilePreviousRundown[];
}) {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const [confirmDelete, setConfirmDelete] = useState<MobileRundownTemplate | null>(null);
  const active=useScreenFocus(),client=useQueryClient(),content=useRef<ScrollView>(null);
  const replacement=useRundownReplacement({orgId,userId,showId},{active,read:readMobileRundownReplacement,send:commandMobileRundownReplacement,
    refresh:async signal=>{
      await Promise.all([
        client.invalidateQueries({queryKey:["mobile-rundown",orgId,showId,userId]},{throwOnError:true}),
        client.invalidateQueries({queryKey:["mobile-rundown-templates",orgId,showId,userId]},{throwOnError:true}),
      ]);
      if(signal.aborted) throw new Error("Show refresh cancelled.");
    },
  });


  const deletion = useTemplateDelete({ orgId, userId, showId }, {
    active, send: deleteMobileRundownTemplate,
    refresh: async signal => {
      await client.invalidateQueries({ queryKey: ["mobile-rundown-templates", orgId, showId, userId] }, { throwOnError: true });
      if (signal.aborted) throw new Error("Template list refresh cancelled.");
    },
  });
  useEffect(() => { setConfirmDelete(null); }, [active, orgId, userId, showId]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <Page scroll={false}>
        <View style={styles.header}>
        <View style={styles.headerCopy}><Text style={styles.eyebrow}>RUNDOWN TEMPLATES</Text><Text style={styles.heading}>Reuse a complete show</Text></View>
        <Pressable accessibilityLabel="Close rundown templates" accessibilityRole="button" onPress={onClose} style={styles.close}><X color={colors.textMuted} size={21} /></Pressable>
      </View>
        <ScrollView ref={content} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <TemplateDeleteStatus state={deletion} active={active}/>
          {confirmDelete ? <View style={styles.saveCard}>
            <Text style={styles.saveTitle}>Delete “{confirmDelete.name}”?</Text>
            <Text style={styles.saveHint}>This removes the saved template with {confirmDelete.itemCount} item{confirmDelete.itemCount === 1 ? "" : "s"}. Existing shows are not affected.</Text>
            <AppButton label="Confirm template deletion" variant="danger" disabled={!active || !canCapture} onPress={() => { deletion.confirm(confirmDelete); setConfirmDelete(null); }}/>
            <AppButton label="Keep template" variant="secondary" onPress={() => setConfirmDelete(null)}/>
          </View> : null}
          <RundownReplacementForm state={replacement} active={active} canReplace={canCapture}/>
          <View style={styles.saveCard}>
            <TemplateSaveForm orgId={orgId} userId={userId} showId={showId} copy={copy} canCapture={canCapture}/>
          </View>

          {previousShows.length > 0 ? (
            <>
              <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>PREVIOUS SHOWS</Text><Text style={styles.sectionCount}>{previousShows.length}</Text></View>
              {previousShows.slice(0, 20).map((show) => (
                <View key={show.id} style={styles.templateCard}>
            <View style={styles.templateCopy}><Text style={styles.templateName}>{show.name || "Untitled show"}</Text><Text style={styles.templateMeta}>{show.serviceDate} · {show.itemCount} item{show.itemCount === 1 ? "" : "s"}{show.location ? ` · ${show.location}` : ""}</Text></View>
            <Pressable accessibilityRole="button" disabled={!!confirmDelete || !!replacement.draft} onPress={() => {replacement.choose({kind:"show",id:show.id});content.current?.scrollTo({y:0,animated:true});}} style={[styles.loadButton, (!!confirmDelete || !!replacement.draft) && styles.disabled]}><Text style={styles.loadText}>Load previous</Text></Pressable>
          </View>
              ))}
            </>
          ) : null}

          <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>SAVED TEMPLATES</Text><Text style={styles.sectionCount}>{templates.length}</Text></View>
          {error ? <View><Text accessibilityRole="alert" style={styles.error}>{error}</Text><AppButton label="Retry saved templates" loading={refreshing} onPress={onRetry}/></View> : null}
          {loading ? (
            <ActivityIndicator color={colors.amber} size="large" />
          ) : templates.length === 0 && !error ? (
            <Text style={styles.empty}>No saved templates yet. Save the current rundown to create one.</Text>
          ) : (
            templates.map((template) => (
              <View key={template.id} style={styles.templateCard}>
          <View style={styles.templateCopy}><Text style={styles.templateName}>{template.name}</Text><Text style={styles.templateMeta}>{template.itemCount} item{template.itemCount === 1 ? "" : "s"}{template.serviceName ? ` · ${template.serviceName}` : ""}{template.scheduledStartTime ? ` · ${template.scheduledStartTime}` : ""}</Text><Text style={styles.templateDate}>Saved {new Date(template.updatedAt).toLocaleDateString()}</Text></View>
          <View style={styles.templateActions}>
            <Pressable accessibilityRole="button" disabled={!canCapture || !!deletion.work[template.id] || !!confirmDelete || !!replacement.draft} onPress={() => {replacement.choose({kind:"template",id:template.id});content.current?.scrollTo({y:0,animated:true});}} style={[styles.loadButton, (!canCapture || !!deletion.work[template.id] || !!confirmDelete || !!replacement.draft) && styles.disabled]}><Text style={styles.loadText}>Load</Text></Pressable>
            <Pressable accessibilityLabel={`Delete ${template.name}`} accessibilityRole="button" disabled={!canCapture || !!deletion.work[template.id] || !!confirmDelete || !!replacement.draft} onPress={() => {setConfirmDelete(template);content.current?.scrollTo({y:0,animated:true});}} style={[styles.deleteButton, (!canCapture || !!deletion.work[template.id] || !!confirmDelete || !!replacement.draft) && styles.disabled]}><Trash2 color={colors.red} size={17} /></Pressable>
          </View>
        </View>
            ))
          )}
        </ScrollView>
      </Page>
    </Modal>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: spacing.medium, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCopy: { flex: 1, minWidth: 0, gap: 5 },
  eyebrow: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "900", letterSpacing: 1.5 },
  heading: { color: colors.text, fontFamily, fontSize: 22, lineHeight: 28, fontWeight: "800" },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  content: { gap: spacing.large, paddingVertical: spacing.large, paddingBottom: 60 },
  saveCard: { gap: spacing.medium, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: spacing.medium },
  saveHeading: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  saveCopy: { flex: 1, minWidth: 0, gap: 4 },
  saveTitle: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  saveHint: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textFaint, fontFamily, fontSize: 12, fontWeight: "900", letterSpacing: 1.4 },
  sectionCount: { color: colors.textFaint, fontFamily, fontSize: 12, fontWeight: "800" },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, borderRadius: radii.medium, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: spacing.large },
  templateCard: { gap: 12, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 14 },
  templateCopy: { gap: 5 },
  templateName: { color: colors.text, fontFamily, fontSize: 15, fontWeight: "800" },
  templateMeta: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  templateDate: { color: colors.textFaint, fontFamily, fontSize: 12 },
  templateActions: { flexDirection: "row", gap: 8 },
  loadButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, backgroundColor: colors.amber },
  loadText: { color: colors.black, fontFamily, fontSize: 12, fontWeight: "800" },
  deleteButton: { width: 46, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
  disabled: { opacity: 0.4 },
}));
