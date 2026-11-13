import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { AppField } from "./app-field";
import { Page } from "./page";
import { useChatInvitation, useChatInviteSharing } from "../hooks/use-chat-invitation";
import { useScreenFocus } from "../hooks/use-screen-polling";
import { createMobileChatInvite, type MobileChatMember } from "../lib/mobile-api";
import type { ChatInviteCommand } from "../lib/chat-pass-recovery";
import { createThemedStyles, fontFamily } from "../theme/tokens";
export function ChatInvitationSheet(props: {
  orgId: string; userId: string; scope: ChatInviteCommand["scope"]; members: MobileChatMember[];
  membersLoading: boolean; membersError: string | null; retryMembers: () => void; onClose: () => void;
}) {
  const styles = useStyles(), active = useScreenFocus();
  const state = useChatInvitation(props, { active, send: createMobileChatInvite });
  const { draft, attempt, pass } = state;
  const [search, setSearch] = useState(""), [confirmNew, setConfirmNew] = useState(false), [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!pass) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, pass.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pass]);
  const expired = !!pass && pass.expiresAt <= now;
  const sharing = useChatInviteSharing(pass, active, async url => {
    try {
      const result = await Share.share({ title: "ShowPilot chat invitation", message: url, url });
      return result?.action === Share.dismissedAction ? "dismissed" : "shared";
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return "dismissed";
      throw error;
    }
  });
  const planning = props.scope === "planning-chat", pending = attempt?.kind === "pending";
  const editable = active && !state.locked;
  const members = props.members.filter(member => member.userId !== props.userId);
  return <Modal animationType="slide" presentationStyle="pageSheet" visible onRequestClose={props.onClose}>
    <Page scroll={false} maxWidth={620}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>{planning ? "Share Planning Room" : "Invite guest crew"}</Text>
        <AppButton label="Close invite" variant="secondary" onPress={props.onClose} />
      </View>
      <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.copy}>{planning ? "Only selected signed-in members can use this expiring link. They also receive an inbox notification." : "Anyone with this expiring link can join Production Chat as a guest."}</Text>
        <Text style={styles.copy}>You can close this form and return to the same request during this signed-in app session.</Text>
        {!pass && <>
          <Text style={styles.label}>Link duration</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Link duration" style={styles.hours}>{[1, 4, 8, 12, 24].map(hours => <Pressable key={hours} accessibilityRole="radio" accessibilityLabel={`${hours} hours`} aria-checked={draft.hours === hours} accessibilityState={{ checked: draft.hours === hours, disabled: !editable }} disabled={!editable} onPress={() => state.setFields({ hours })} style={[styles.choice, draft.hours === hours && styles.selected]}><Text style={styles.copy}>{hours}h</Text></Pressable>)}</View>
          {planning && <>
            <Text style={styles.label}>Members · {draft.targetUserIds.length} selected (maximum 50)</Text>
            {draft.targetUserIds.length > 0 && <AppButton label="Clear selected members" variant="secondary" disabled={!editable} onPress={() => state.setFields({ targetUserIds: [] })} />}
            <AppField label="Search invite members" value={search} onChangeText={setSearch} />
            {props.membersLoading ? <Text style={styles.copy}>Loading members…</Text> : props.membersError ? <View style={styles.group}><Text accessibilityRole="alert" style={styles.error}>{props.membersError}</Text><AppButton label="Retry invite members" variant="secondary" onPress={props.retryMembers} /></View> : <>
              {members.filter(member => member.name.toLowerCase().includes(search.toLowerCase())).map(member => {
                const checked = draft.targetUserIds.includes(member.userId);
                return <Pressable key={member.userId} accessibilityRole="checkbox" accessibilityLabel={member.name} aria-checked={checked} accessibilityState={{ checked, disabled: !editable }} disabled={!editable} onPress={() => state.setFields({ targetUserIds: checked ? draft.targetUserIds.filter(id => id !== member.userId) : [...draft.targetUserIds, member.userId] })} style={[styles.member, checked && styles.selected]}><Text style={styles.copy}>{checked ? "✓ " : "○ "}{member.name}</Text><Text style={styles.detail}>{member.role}</Text></Pressable>;
              })}
              {!members.some(member => member.name.toLowerCase().includes(search.toLowerCase())) && <Text style={styles.copy}>No members match this search.</Text>}
            </>}
          </>}
        </>}
        {draft.error && <Text accessibilityRole="alert" style={styles.error}>{draft.error}</Text>}
        {pending && <Text accessibilityRole="text" style={styles.copy}>Confirming link and notifications…</Text>}
        {attempt?.kind === "failed" && <View style={styles.group}><Text accessibilityRole="alert" style={styles.error}>{attempt.message}</Text><AppButton label="Retry original invite" disabled={!active} onPress={state.retry} /></View>}
        {pass && <View style={styles.group}>
          <Text style={styles.label}>{expired ? "This link has expired" : planning ? "Planning link is ready" : "Crew pass is ready"}</Text>
          <AppField label="Chat invitation link" value={pass.joinUrl} editable={false} selectTextOnFocus multiline style={styles.link} />
          <Text style={styles.copy}>Expires {new Date(pass.expiresAt).toLocaleString()}{planning ? ` · ${pass.targetCount ?? 0} selected ${pass.targetCount === 1 ? "member" : "members"}` : ""}</Text>
          {pass.notifications.status === "saved" && <Text style={styles.copy}>Inbox notifications saved for {pass.notifications.recipients} {pass.notifications.recipients === 1 ? "member" : "members"}. Device push delivery is not confirmed.</Text>}
          {pass.notifications.status === "pending" && <View style={styles.group}><Text accessibilityRole="alert" style={styles.error}>The link is ready, but {pass.notifications.missing} inbox {pass.notifications.missing === 1 ? "notification" : "notifications"} could not be confirmed.</Text><AppButton label="Retry invite notifications" variant="secondary" disabled={pending || expired || !active} onPress={state.retry} /></View>}
          <AppButton label={sharing.kind === "failed" ? "Retry sharing invite" : sharing.kind === "pending" ? "Opening share sheet…" : "Share invite link"} disabled={expired || sharing.kind === "pending" || !active} onPress={() => void sharing.open()} />
          {sharing.kind === "failed" && <Text accessibilityRole="alert" style={styles.error}>{sharing.error} Select the link above to copy it manually.</Text>}
          {sharing.kind === "dismissed" && <Text style={styles.copy}>Sharing was cancelled. Your link is still available.</Text>}
          {sharing.kind === "shared" && <Text style={styles.copy}>Share sheet completed. Your link is still available.</Text>}
        </View>}
        {!attempt && <AppButton label={planning ? "Create Planning link" : "Create crew pass"} disabled={!active || (planning && (props.membersLoading || !!props.membersError))} onPress={() => state.create(members.map(member => member.userId))} />}
        {attempt && !pending && <>
          <Text style={styles.copy}>Retry keeps the original link and expiry. Starting a new link leaves any earlier link active until it expires or is disabled.</Text>
          {confirmNew ? <View style={styles.group}>
            <Text style={styles.copy}>Leave this request and prepare another link? Any existing link stays active.</Text>
            <AppButton label="Keep current invite" variant="secondary" onPress={() => setConfirmNew(false)} />
            <AppButton label="Confirm new invite" variant="secondary" disabled={sharing.kind === "pending"} onPress={() => { state.startNew(); setConfirmNew(false); }} />
          </View> : <AppButton label="Start a new invite" variant="secondary" disabled={sharing.kind === "pending"} onPress={() => setConfirmNew(true)} />}
        </>}
      </ScrollView>
    </Page>
  </Modal>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  header: { gap: 12, paddingBottom: 12 }, title: { color: colors.text, fontFamily, fontSize: 22, lineHeight: 28, fontWeight: "800" },
  content: { gap: 14, paddingBottom: 32 }, group: { gap: 12 },
  copy: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 21 }, detail: { color: colors.textMuted, fontFamily, fontSize: 12, lineHeight: 18 },
  label: { color: colors.text, fontFamily, fontSize: 15, lineHeight: 21, fontWeight: "700" }, error: { color: colors.red, fontFamily, fontSize: 14, lineHeight: 21 },
  hours: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, choice: { minWidth: 52, minHeight: 48, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: 12 },
  member: { minHeight: 52, gap: 2, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 }, selected: { borderColor: colors.amberText, backgroundColor: colors.panelStrong },
  link: { minHeight: 110, paddingVertical: 12, fontSize: 13, lineHeight: 19, textAlignVertical: "top" },
}));
