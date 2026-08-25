import { useEffect, useRef, useState } from "react";
import { Hash, Send, Wifi, WifiOff } from "lucide-react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Page } from "@/components/page";
import { useChatRelay, type MobileChatMessage } from "@/hooks/use-chat-relay";
import { authClient } from "@/lib/auth-client";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

function MessageCard({ message, own }: { message: MobileChatMessage; own: boolean }) {
  const styles = useStyles();
  const deleted = Boolean(message.deletedAt);
  return (
    <View style={[styles.message, own && styles.messageOwn, message.type === "alert" && styles.messageAlert]}>
      <View style={styles.messageHeader}><Text style={styles.sender}>{own ? "You" : message.senderName}</Text>{message.senderRole ? <Text style={styles.role}>{message.senderRole}</Text> : null}<Text style={styles.time}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text></View>
      <Text style={[styles.messageText, deleted && styles.deleted]}>{deleted ? "Message deleted" : message.text}</Text>
    </View>
  );
}

export default function ChatScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const params = useLocalSearchParams<{ room?: string }>();
  const { data: organization } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  const requestedRoom = typeof params.room === "string" ? params.room : "production";
  const roomParts = requestedRoom.split(":");
  const roomId = requestedRoom === "production" || requestedRoom === "planning"
    || (roomParts.length === 3 && roomParts[0] === "dm" && Boolean(roomParts[1]) && roomParts[1] < roomParts[2])
    ? requestedRoom
    : "production";
  const relay = useChatRelay(organization?.id, roomId);
  const [text, setText] = useState("");
  const listRef = useRef<FlatList<MobileChatMessage>>(null);
  useEffect(() => {
    if (relay.messages.length) requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
  }, [relay.messages.length]);
  if (!organization) return <Redirect href="/organizations" />;

  function send() {
    if (!relay.send(text)) return;
    setText("");
    void Haptics.selectionAsync();
  }

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={88}>
      <Page scroll={false}>
        <View style={styles.roomHeader}><View style={styles.roomIcon}><Hash color={colors.amberText} size={19} /></View><View style={styles.roomCopy}><Text style={styles.roomTitle}>{roomId === "production" ? "Production Chat" : roomId === "planning" ? "Planning Room" : "Direct message"}</Text><Text style={styles.roomSubtitle}>{roomId === "planning" ? "Seven-day planning channel" : roomId.startsWith("dm:") ? "Private crew conversation" : "Live crew channel"}</Text></View>{relay.status === "connected" ? <Wifi color={colors.green} size={17} /> : <WifiOff color={colors.amberText} size={17} />}<Text style={[styles.connection, relay.status === "connected" && styles.connected]}>{relay.status}</Text></View>
        {relay.lastError ? <Text style={styles.error}>{relay.lastError}</Text> : null}
        <FlatList ref={listRef} style={styles.list} contentContainerStyle={styles.listContent} data={relay.messages} keyExtractor={(item) => item.id} renderItem={({ item }) => <MessageCard message={item} own={item.senderId === session?.user.id} />} ListEmptyComponent={<Text style={styles.empty}>{relay.status === "connected" ? "No messages yet. Start the production conversation." : "Connecting to the production room…"}</Text>} onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })} />
        <View style={styles.composer}><TextInput accessibilityLabel="Message production chat" multiline maxLength={4000} value={text} onChangeText={setText} onSubmitEditing={send} placeholder={relay.status === "connected" ? "Message the crew…" : "Message will send when reconnected…"} placeholderTextColor={colors.textFaint} style={styles.input} /><Pressable accessibilityRole="button" accessibilityLabel="Send message" disabled={!text.trim()} onPress={send} style={({ pressed }) => [styles.send, !text.trim() && styles.disabled, pressed && styles.pressed]}><Send color={colors.black} size={19} /></Pressable></View>
      </Page>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.stage },
  roomHeader: { flexDirection: "row", alignItems: "center", gap: 9 },
  roomIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.amberSoft },
  roomCopy: { flex: 1, gap: 3 },
  roomTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "800" },
  roomSubtitle: { color: colors.textMuted, fontFamily, fontSize: 11 },
  connection: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800", textTransform: "uppercase" },
  connected: { color: colors.green },
  error: { color: colors.red, fontFamily, fontSize: 11 },
  list: { flex: 1, marginHorizontal: -spacing.large },
  listContent: { flexGrow: 1, justifyContent: "flex-end", gap: 8, paddingHorizontal: spacing.large, paddingVertical: spacing.small },
  message: { alignSelf: "flex-start", maxWidth: "88%", gap: 6, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 12 },
  messageOwn: { alignSelf: "flex-end", borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  messageAlert: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  messageHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  sender: { color: colors.text, fontFamily, fontSize: 10, fontWeight: "900" },
  role: { color: colors.textFaint, fontFamily, fontSize: 8, fontWeight: "800", textTransform: "uppercase" },
  time: { marginLeft: "auto", color: colors.textFaint, fontFamily, fontSize: 8 },
  messageText: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20 },
  deleted: { color: colors.textFaint, fontStyle: "italic" },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", marginVertical: 50 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 9, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.small },
  input: { flex: 1, maxHeight: 110, minHeight: 44, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, paddingHorizontal: 13, paddingVertical: 11 },
  send: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72 },
}));
