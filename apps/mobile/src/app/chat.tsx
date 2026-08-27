import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Check from "lucide-react-native/icons/check";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import CornerUpLeft from "lucide-react-native/icons/corner-up-left";
import Hash from "lucide-react-native/icons/hash";
import ImageIcon from "lucide-react-native/icons/image";
import Pencil from "lucide-react-native/icons/pencil";
import Send from "lucide-react-native/icons/send";
import Trash2 from "lucide-react-native/icons/trash-2";
import Wifi from "lucide-react-native/icons/wifi";
import WifiOff from "lucide-react-native/icons/wifi-off";
import X from "lucide-react-native/icons/x";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "@/lib/haptics";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Page } from "@/components/page";
import { LoadingView } from "@/components/loading-view";
import { useChatRelay, type MobileChatMessage } from "@/hooks/use-chat-relay";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useRundownRelay } from "@/hooks/use-rundown-relay";
import { authClient } from "@/lib/auth-client";
import { getNativeCookieHeader } from "@/lib/auth-transport";
import { mobileChatReactionEmojis, type MobileChatReactionEmoji } from "@/lib/chat-history";
import { SHOWPILOT_URL } from "@/lib/env";
import {
  createMobileCrewChatPass,
  createMobilePlanningChatPass,
  downloadMobileChatAttachment,
  getMobileChatMembers,
  getMobileRundown,
  notifyMobileChatMessage,
  notifyMobileChatReaction,
  uploadMobileChatAttachment,
  type MobileChatAttachment,
  type MobileChatMember,
  type MobileRundown,
} from "@/lib/mobile-api";
import { createThemedStyles, fontFamily, radii, spacing, useAppTheme } from "@/theme/tokens";

type MessageType = "text" | "cue" | "alert";

function readableChatText(text: string) {
  return text.replace(/<@([^|>]+)\|([^>]+)>/g, "@$2");
}

function directMessageRoom(firstUserId: string, secondUserId: string) {
  return `dm:${[firstUserId, secondUserId].sort().join(":")}`;
}

function absoluteChatFileUrl(url: string) {
  return new URL(url, SHOWPILOT_URL).toString();
}

interface MessageCardProps {
  currentUserId?: string;
  focused: boolean;
  message: MobileChatMessage;
  own: boolean;
  seen: boolean;
  onLongPress: (message: MobileChatMessage) => void;
  onOpenAttachment: (attachment: NonNullable<MobileChatMessage["attachments"]>[number]) => void;
  onReact: (message: MobileChatMessage) => void;
  onToggleReaction: (message: MobileChatMessage, emoji: MobileChatReactionEmoji) => void;
  onVote: (messageId: string, optionId: string) => void;
}

const MessageCard = memo(function MessageCard({
  currentUserId,
  focused,
  message,
  own,
  seen,
  onLongPress,
  onOpenAttachment,
  onReact,
  onToggleReaction,
  onVote,
}: MessageCardProps) {
  const styles = useStyles();
  const deleted = Boolean(message.deletedAt);
  return (
    <Pressable
      accessibilityHint="Hold for reply and message actions"
      accessibilityLabel={`${own ? "You" : message.senderName}: ${readableChatText(message.text) || "attachment"}`}
      delayLongPress={350}
      onLongPress={() => onLongPress(message)}
      style={[
        styles.message,
        own && styles.messageOwn,
        message.type === "alert" && styles.messageAlert,
        message.type === "cue" && styles.messageCue,
        focused && styles.messageFocused,
      ]}
    >
      <View style={styles.messageHeader}>
        <Text style={styles.sender}>{own ? "You" : message.senderName}</Text>
        {message.senderRole ? <Text style={styles.role}>{message.senderRole}</Text> : null}
        {message.type !== "text" ? <Text style={message.type === "alert" ? styles.alertBadge : styles.cueBadge}>{message.type}</Text> : null}
        <Text style={styles.time}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
      </View>
      {message.replyTo && !deleted ? (
        <View style={styles.replyReference}>
          <Text numberOfLines={1} style={styles.replySender}>{message.replyTo.senderName}</Text>
          <Text numberOfLines={2} style={styles.replyText}>{readableChatText(message.replyTo.text)}</Text>
        </View>
      ) : null}
      <Text style={[styles.messageText, deleted && styles.deleted]}>
        {deleted ? "Message deleted" : readableChatText(message.text)}
      </Text>
      {!deleted && message.attachments?.map((attachment) => {
        const isImage = attachment.mimeType.startsWith("image/");
        return (
          <Pressable accessibilityRole="link" key={attachment.id} onPress={() => onOpenAttachment(attachment)} style={styles.attachment}>
            {isImage ? (
              <Image
                resizeMode="cover"
                source={{ uri: absoluteChatFileUrl(attachment.url), headers: getNativeCookieHeader() }}
                style={styles.attachmentImage}
              />
            ) : <ImageIcon color={styles.attachmentName.color} size={20} />}
            <View style={styles.attachmentCopy}>
              <Text numberOfLines={1} style={styles.attachmentName}>{attachment.name}</Text>
              <Text style={styles.attachmentMeta}>{Math.max(1, Math.ceil(attachment.size / 1024))} KB</Text>
            </View>
          </Pressable>
        );
      })}
      {!deleted && message.poll ? (
        <View style={styles.poll}>
          <Text style={styles.pollQuestion}>{message.poll.question}</Text>
          {message.poll.options.map((option) => {
            const selected = Boolean(currentUserId && option.voterIds.includes(currentUserId));
            return (
              <Pressable accessibilityRole="button" accessibilityState={{ selected }} key={option.id} onPress={() => onVote(message.id, option.id)} style={[styles.pollOption, selected && styles.pollOptionSelected]}>
                <View style={[styles.pollCheck, selected && styles.pollCheckSelected]}>{selected ? <Check color={styles.pollCheckMark.color} size={11} strokeWidth={3} /> : null}</View>
                <Text style={styles.pollOptionText}>{option.text}</Text>
                <Text style={styles.pollCount}>{option.voterIds.length}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {!deleted ? (
        <View style={styles.reactions}>
          {message.reactions?.filter((reaction) => reaction.userIds.length > 0).map((reaction) => {
            const selected = Boolean(currentUserId && reaction.userIds.includes(currentUserId));
            return (
              <Pressable accessibilityRole="button" accessibilityState={{ selected }} key={reaction.emoji} onPress={() => onToggleReaction(message, reaction.emoji)} style={[styles.reaction, selected && styles.reactionSelected]}>
                <Text style={styles.reactionText}>{reaction.emoji} {reaction.userIds.length}</Text>
              </Pressable>
            );
          })}
          <Pressable accessibilityLabel="Add reaction" accessibilityRole="button" onPress={() => onReact(message)} style={styles.reactionAdd}><Text style={styles.reactionAddText}>＋</Text></Pressable>
        </View>
      ) : null}
      {message.editedAt && !deleted ? <Text style={styles.edited}>edited</Text> : null}
      {own && seen ? <Text style={styles.seen}>Seen</Text> : null}
    </Pressable>
  );
});

function LiveChatStatus({ detail, orgId }: { detail: MobileRundown; orgId: string }) {
  const styles = useStyles();
  const relay = useRundownRelay(orgId, detail.show.serviceDate, detail.show.id);
  const sameRoom = relay.showId === detail.show.id && relay.serviceDate === detail.show.serviceDate;
  const relayIsAuthoritative = relay.hydrated && sameRoom && relay.initialized;
  const timer = relayIsAuthoritative ? relay.timer : detail.timer;
  const items = relayIsAuthoritative ? relay.items : detail.items;
  if (timer.playback !== "play" || !timer.currentItemId) return null;
  const currentItem = items.find((item) => item.id === timer.currentItemId);
  if (!currentItem) return null;
  return <View style={styles.liveStatus}><View style={styles.liveDot} /><Text style={styles.liveLabel}>LIVE NOW</Text><Text numberOfLines={1} style={styles.liveItem}>{currentItem.title}</Text></View>;
}

export default function ChatScreen() {
  const { colors } = useAppTheme();
  const styles = useStyles();
  const router = useRouter();
  const params = useLocalSearchParams<{ message?: string; room?: string }>();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  const requestedRoom = typeof params.room === "string" ? params.room : "production";
  const roomParts = requestedRoom.split(":");
  const roomId = requestedRoom === "production" || requestedRoom === "planning"
    || (roomParts.length === 3 && roomParts[0] === "dm" && Boolean(roomParts[1]) && roomParts[1] < roomParts[2])
    ? requestedRoom
    : "production";
  const focusedMessageId = typeof params.message === "string" ? params.message : null;
  const relay = useChatRelay(organization?.id, roomId);
  const bootstrap = useMobileBootstrap({ poll: true });
  const openingShow = bootstrap.data?.shows[0];
  const canViewRundown = bootstrap.data?.identity.permissions.some((permission) => permission === "rundown:view" || permission === "rundown:control") ?? false;
  const liveRundownQuery = useQuery({
    queryKey: ["mobile-chat-live-rundown", organization?.id, openingShow?.id],
    queryFn: () => getMobileRundown(organization!.id, openingShow!.id),
    enabled: Boolean(organization?.id && openingShow?.id && canViewRundown),
    staleTime: 30_000,
  });
  const {
    deleteMessage,
    messages,
    readReceipts,
    toggleReaction: mutateReaction,
    votePoll,
  } = relay;
  const membersQuery = useQuery({
    queryKey: ["mobile-chat-members", organization?.id],
    queryFn: () => getMobileChatMembers(organization!.id),
    enabled: Boolean(organization?.id),
    staleTime: 60_000,
  });
  const [text, setText] = useState("");
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [replyingTo, setReplyingTo] = useState<MobileChatMessage | null>(null);
  const [editing, setEditing] = useState<MobileChatMessage | null>(null);
  const [attachment, setAttachment] = useState<MobileChatAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareHours, setShareHours] = useState(4);
  const [selectedShareMemberIds, setSelectedShareMemberIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState(false);
  const [actionTarget, setActionTarget] = useState<MobileChatMessage | null>(null);
  const [reactionTarget, setReactionTarget] = useState<MobileChatMessage | null>(null);
  const listRef = useRef<FlatList<MobileChatMessage>>(null);
  const initialScrollDoneRef = useRef(false);
  const focusScrollDoneRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNotificationsRef = useRef(new Map<string, { text: string; mentionedUserIds: string[] }>());
  const members = useMemo(() => membersQuery.data?.members ?? [], [membersQuery.data?.members]);
  const currentUserId = membersQuery.data?.currentUserId ?? session?.user.id;
  const otherDmUserId = roomId.startsWith("dm:") ? roomParts.slice(1).find((userId) => userId !== currentUserId) : null;
  const dmMember = members.find((member) => member.userId === otherDmUserId);
  const roomTitle = roomId === "production" ? "Production Chat" : roomId === "planning" ? "Planning Room" : dmMember?.name ?? "Direct message";
  const memberSearchResults = useMemo(() => {
    const needle = roomSearch.trim().toLowerCase();
    return members.filter((member) => member.userId !== currentUserId
      && (!needle || member.name.toLowerCase().includes(needle) || member.role.toLowerCase().includes(needle)));
  }, [currentUserId, members, roomSearch]);
  const mentionNeedle = /(?:^|\s)@([^\s@]*)$/.exec(text)?.[1].toLowerCase() ?? null;
  const mentionResults = useMemo(() => {
    if (mentionNeedle === null) return [];
    return members.filter((member) => member.userId !== currentUserId && member.name.toLowerCase().includes(mentionNeedle)).slice(0, 5);
  }, [currentUserId, members, mentionNeedle]);
  const otherReadAt = useMemo(() => Math.max(0, ...Object.entries(readReceipts)
    .filter(([userId]) => userId !== currentUserId)
    .map(([, readAt]) => readAt)), [currentUserId, readReceipts]);
  const latestOwnMessageId = useMemo(() => messages.findLast((message) => message.senderId === currentUserId)?.id ?? null, [currentUserId, messages]);

  useEffect(() => {
    initialScrollDoneRef.current = false;
    focusScrollDoneRef.current = null;
    stickToBottomRef.current = true;
    setReplyingTo(null);
    setEditing(null);
    setAttachment(null);
    pendingNotificationsRef.current.clear();
  }, [roomId]);

  const setRelayTyping = relay.setTyping;
  useEffect(() => () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    setRelayTyping(false);
  }, [setRelayTyping]);

  useEffect(() => {
    if (!focusedMessageId || focusScrollDoneRef.current === focusedMessageId) return;
    const index = relay.messages.findIndex((message) => message.id === focusedMessageId);
    if (index < 0) return;
    focusScrollDoneRef.current = focusedMessageId;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 }));
  }, [focusedMessageId, relay.messages]);

  useEffect(() => {
    if (!organization) return;
    for (const message of messages) {
      const pending = pendingNotificationsRef.current.get(message.id);
      if (!pending) continue;
      pendingNotificationsRef.current.delete(message.id);
      void notifyMobileChatMessage({
        orgId: organization.id,
        roomId,
        text: pending.text,
        mentionedUserIds: pending.mentionedUserIds,
        messageId: message.id,
      }).catch(() => undefined);
    }
  }, [messages, organization, roomId]);

  function updateText(value: string) {
    setText(value);
    relay.setTyping(Boolean(value.trim()));
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => relay.setTyping(false), 2_500);
  }

  function clearComposer() {
    setText("");
    setReplyingTo(null);
    setEditing(null);
    setAttachment(null);
    setMessageType("text");
    relay.setTyping(false);
  }

  async function submit() {
    if (editing) {
      try {
        await relay.editMessage(editing.id, text);
        clearComposer();
        await Haptics.selectionAsync();
      } catch (error) {
        Alert.alert("Message not edited", error instanceof Error ? error.message : "Try again.");
      }
      return;
    }
    const messageId = relay.send(text, messageType, {
      ...(replyingTo ? { replyTo: { messageId: replyingTo.id, senderName: replyingTo.senderName, text: replyingTo.text } } : {}),
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    if (!messageId) return;
    const cleanText = text;
    const mentionedUserIds = members
      .filter((member) => new RegExp(`(^|\\s)@${member.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$|[.,!?])`, "i").test(cleanText))
      .map((member) => member.userId);
    clearComposer();
    await Haptics.selectionAsync();
    pendingNotificationsRef.current.set(messageId, { text: cleanText, mentionedUserIds });
  }

  async function chooseAttachment() {
    if (!organization) return;
    setUploading(true);
    try {
      const selection = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.85 });
      if (selection.canceled) return;
      const asset = selection.assets[0];
      const uploaded = await uploadMobileChatAttachment({ orgId: organization.id, roomId, uri: asset.uri, name: asset.fileName });
      setAttachment(uploaded);
    } catch (error) {
      Alert.alert("Attachment not added", error instanceof Error ? error.message : "Choose another image.");
    } finally {
      setUploading(false);
    }
  }

  async function chooseDocument() {
    if (!organization) return;
    setUploading(true);
    try {
      const selection = await DocumentPicker.getDocumentAsync({
        type: [
          "application/pdf", "text/plain", "text/csv",
          "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ],
        copyToCacheDirectory: true,
        multiple: false,
        base64: false,
      });
      if (selection.canceled) return;
      const file = selection.assets[0];
      const uploaded = await uploadMobileChatAttachment({ orgId: organization.id, roomId, uri: file.uri, name: file.name });
      setAttachment(uploaded);
    } catch (error) {
      Alert.alert("Attachment not added", error instanceof Error ? error.message : "Choose another file.");
    } finally {
      setUploading(false);
    }
  }

  async function openAttachment(file: MobileChatAttachment) {
    try {
      if (Platform.OS === "web") {
        await Linking.openURL(absoluteChatFileUrl(file.url));
        return;
      }
      if (!await Sharing.isAvailableAsync()) throw new Error("File opening is not available on this device.");
      const localUri = await downloadMobileChatAttachment(file);
      await Sharing.shareAsync(localUri, { mimeType: file.mimeType, dialogTitle: file.name });
    } catch (error) {
      Alert.alert("Attachment not opened", error instanceof Error ? error.message : "Try opening it from the web app.");
    }
  }

  function sendPoll() {
    const question = pollQuestion.trim();
    const options = pollOptions.map((option) => option.trim()).filter(Boolean);
    if (!question || options.length < 2) return;
    const messageId = relay.send("", "text", { poll: { question, options } });
    if (!messageId) return;
    setPollOpen(false);
    setPollQuestion("");
    setPollOptions(["", ""]);
    pendingNotificationsRef.current.set(messageId, { text: question, mentionedUserIds: [] });
  }

  function selectMention(member: MobileChatMember) {
    const atIndex = text.lastIndexOf("@");
    if (atIndex < 0) return;
    updateText(`${text.slice(0, atIndex)}@${member.name} `);
  }

  async function createAndShareInvite() {
    if (!organization || (roomId === "planning" && selectedShareMemberIds.length === 0)) return;
    setSharing(true);
    try {
      const pass = roomId === "planning"
        ? await createMobilePlanningChatPass({ orgId: organization.id, hours: shareHours, targetUserIds: selectedShareMemberIds })
        : await createMobileCrewChatPass({ orgId: organization.id, hours: shareHours });
      setShareOpen(false);
      await Share.share({
        title: roomId === "planning" ? "ShowPilot Planning Room" : "ShowPilot Production Chat",
        message: `${roomId === "planning" ? "Join the ShowPilot Planning Room" : "Join the ShowPilot production crew chat"}: ${pass.joinUrl}`,
        url: pass.joinUrl,
      });
    } catch (error) {
      Alert.alert("Invite not created", error instanceof Error ? error.message : "Try again.");
    } finally {
      setSharing(false);
    }
  }

  const openMessageActions = useCallback((message: MobileChatMessage) => {
    if (message.deletedAt) return;
    setActionTarget(message);
  }, []);

  const confirmDelete = useCallback((message: MobileChatMessage) => {
    setActionTarget(null);
    Alert.alert("Delete message?", "The message will remain in the conversation as deleted.", [
      { text: "Keep message", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteMessage(message.id).catch((error: Error) => Alert.alert("Message not deleted", error.message)) },
    ]);
  }, [deleteMessage]);

  const toggleReaction = useCallback(async (message: MobileChatMessage, emoji: MobileChatReactionEmoji) => {
    const removing = Boolean(currentUserId && message.reactions?.some((reaction) => reaction.emoji === emoji && reaction.userIds.includes(currentUserId)));
    try {
      await mutateReaction(message.id, emoji);
      setReactionTarget(null);
      if (!removing && organization && message.senderId) {
        void notifyMobileChatReaction({ orgId: organization.id, roomId, messageId: message.id, targetUserId: message.senderId, emoji }).catch(() => undefined);
      }
    } catch (error) {
      Alert.alert("Reaction not saved", error instanceof Error ? error.message : "Try again.");
    }
  }, [currentUserId, mutateReaction, organization, roomId]);

  function trackScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickToBottomRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 96;
  }

  function keepLatestMessageVisible() {
    if (!relay.messages.length || focusedMessageId) return;
    if (!initialScrollDoneRef.current || stickToBottomRef.current) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: initialScrollDoneRef.current }));
    }
    initialScrollDoneRef.current = true;
  }

  const renderMessage = useCallback<ListRenderItem<MobileChatMessage>>(
    ({ item }) => {
      return (
        <MessageCard
          currentUserId={currentUserId}
          focused={item.id === focusedMessageId}
          message={item}
          onLongPress={openMessageActions}
          onOpenAttachment={(file) => void openAttachment(file)}
          onReact={setReactionTarget}
          onToggleReaction={(message, emoji) => void toggleReaction(message, emoji)}
          onVote={(messageId, optionId) => void votePoll(messageId, optionId).catch((error: Error) => Alert.alert("Vote not saved", error.message))}
          own={item.senderId === currentUserId}
          seen={roomId.startsWith("dm:") && item.id === latestOwnMessageId && otherReadAt >= item.timestamp}
        />
      );
    },
    [currentUserId, focusedMessageId, latestOwnMessageId, openMessageActions, otherReadAt, roomId, toggleReaction, votePoll],
  );

  if (organizationPending) return <LoadingView label="Opening chat…" />;
  if (!organization) return <Redirect href="/organizations" />;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={88}>
      <Page scroll={false}>
        <View style={styles.roomHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Switch chat room. Current room: ${roomTitle}`} onPress={() => setRoomPickerOpen(true)} style={styles.roomSwitcher}>
            <View style={styles.roomIcon}><Hash color={colors.amberText} size={19} /></View>
            <View style={styles.roomCopy}><Text style={styles.roomTitle}>{roomTitle}</Text><Text style={styles.roomSubtitle}>{roomId === "planning" ? "Seven-day planning channel" : roomId.startsWith("dm:") ? "Private crew conversation" : "Live crew channel"}</Text></View>
            <ChevronDown color={colors.textMuted} size={17} />
          </Pressable>
          {relay.status === "connected" ? <Wifi color={colors.green} size={17} /> : <WifiOff color={colors.amberText} size={17} />}
          <Text style={[styles.connection, relay.status === "connected" && styles.connected]}>{relay.status}</Text>
          {membersQuery.data?.canInvite && !roomId.startsWith("dm:") ? <Pressable accessibilityRole="button" accessibilityLabel={roomId === "planning" ? "Share Planning Room" : "Invite guest crew"} onPress={() => { setSelectedShareMemberIds([]); setShareOpen(true); }} style={styles.shareButton}><Text style={styles.shareButtonText}>SHARE</Text></Pressable> : null}
        </View>
        {relay.lastError ? <Text style={styles.error}>{relay.lastError}</Text> : null}
        {liveRundownQuery.data ? <LiveChatStatus detail={liveRundownQuery.data} orgId={organization.id} /> : null}
        <FlatList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={relay.messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          initialNumToRender={18}
          maxToRenderPerBatch={12}
          windowSize={7}
          ListHeaderComponent={relay.hasOlder ? (
            <Pressable accessibilityRole="button" accessibilityState={{ busy: relay.loadingOlder, disabled: relay.loadingOlder }} disabled={relay.loadingOlder} onPress={() => void relay.loadOlder()} style={({ pressed }) => [styles.olderButton, pressed && styles.pressed]}>
              <Text style={styles.olderText}>{relay.loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}</Text>
            </Pressable>
          ) : null}
          ListEmptyComponent={<Text style={styles.empty}>{relay.status === "connected" ? "No messages yet. Start the conversation." : "Connecting to this room…"}</Text>}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onContentSizeChange={keepLatestMessageVisible}
          onScroll={trackScroll}
          onScrollToIndexFailed={({ index }) => setTimeout(() => listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 }), 250)}
          scrollEventThrottle={16}
        />
        {relay.typingUsers.filter((user) => user.userId !== currentUserId).length ? <Text style={styles.typing}>{relay.typingUsers.filter((user) => user.userId !== currentUserId).map((user) => user.name).join(", ")} typing…</Text> : null}
        {replyingTo || editing ? (
          <View style={styles.composerContext}>
            {editing ? <Pencil color={colors.amberText} size={15} /> : <CornerUpLeft color={colors.amberText} size={15} />}
            <View style={styles.composerContextCopy}><Text style={styles.composerContextTitle}>{editing ? "Editing message" : `Replying to ${replyingTo?.senderName}`}</Text><Text numberOfLines={1} style={styles.composerContextText}>{readableChatText((editing ?? replyingTo)?.text ?? "")}</Text></View>
            <Pressable accessibilityLabel="Cancel message action" onPress={() => { setEditing(null); setReplyingTo(null); if (editing) setText(""); }}><X color={colors.textMuted} size={18} /></Pressable>
          </View>
        ) : null}
        {attachment ? <View style={styles.pendingAttachment}><ImageIcon color={colors.amberText} size={17} /><Text numberOfLines={1} style={styles.pendingAttachmentName}>{attachment.name}</Text><Pressable accessibilityLabel="Remove attachment" onPress={() => setAttachment(null)}><X color={colors.textMuted} size={17} /></Pressable></View> : null}
        {mentionResults.length ? <View style={styles.mentions}>{mentionResults.map((member) => <Pressable key={member.userId} onPress={() => selectMention(member)} style={styles.mention}><Text style={styles.mentionName}>@{member.name}</Text><Text style={styles.mentionRole}>{member.role}</Text></Pressable>)}</View> : null}
        {!editing ? <View style={styles.composerTools}>
          {(["text", "cue", "alert"] as const).map((type) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: messageType === type }} key={type} onPress={() => setMessageType(type)} style={[styles.typeChoice, messageType === type && styles.typeChoiceActive]}><Text style={[styles.typeChoiceText, messageType === type && styles.typeChoiceTextActive]}>{type}</Text></Pressable>)}
          <Pressable accessibilityLabel="Attach image" disabled={uploading} onPress={() => void chooseAttachment()} style={styles.toolButton}>{uploading ? <ActivityIndicator color={colors.textMuted} size="small" /> : <ImageIcon color={colors.textMuted} size={17} />}</Pressable>
          <Pressable accessibilityLabel="Attach document" disabled={uploading} onPress={() => void chooseDocument()} style={styles.toolButton}><Text style={styles.pollTool}>FILE</Text></Pressable>
          <Pressable accessibilityLabel="Create poll" onPress={() => setPollOpen(true)} style={styles.toolButton}><Text style={styles.pollTool}>POLL</Text></Pressable>
        </View> : null}
        <View style={styles.composer}>
          <TextInput accessibilityLabel={`Message ${roomTitle}`} multiline maxLength={4000} value={text} onChangeText={updateText} placeholder={relay.status === "connected" ? "Message the crew… Use @ to mention" : "Message will send when reconnected…"} placeholderTextColor={colors.textFaint} style={styles.input} />
          <Pressable accessibilityRole="button" accessibilityLabel={editing ? "Save edited message" : "Send message"} accessibilityState={{ disabled: !text.trim() && !attachment }} disabled={!text.trim() && !attachment} onPress={() => void submit()} style={({ pressed }) => [styles.send, !text.trim() && !attachment && styles.disabled, pressed && styles.pressed]}><Send color={colors.black} size={19} /></Pressable>
        </View>
      </Page>

      <Modal animationType="slide" onRequestClose={() => setRoomPickerOpen(false)} transparent visible={roomPickerOpen}>
        <Pressable onPress={() => setRoomPickerOpen(false)} style={styles.modalBackdrop}>
          <Pressable onPress={() => undefined} style={styles.sheet}>
            <View style={styles.sheetHeader}><View><Text style={styles.sheetEyebrow}>CHAT ROOMS</Text><Text style={styles.sheetTitle}>Choose a conversation</Text></View><Pressable accessibilityLabel="Close room picker" onPress={() => setRoomPickerOpen(false)}><X color={colors.textMuted} size={22} /></Pressable></View>
            {[{ id: "production", name: "Production Chat", detail: "Live crew channel" }, { id: "planning", name: "Planning Room", detail: "Seven-day planning" }].map((room) => <Pressable key={room.id} onPress={() => { router.setParams({ room: room.id, message: "" }); setRoomPickerOpen(false); }} style={[styles.roomChoice, roomId === room.id && styles.roomChoiceActive]}><Hash color={roomId === room.id ? colors.amberText : colors.textMuted} size={18} /><View style={styles.roomChoiceCopy}><Text style={styles.roomChoiceName}>{room.name}</Text><Text style={styles.roomChoiceDetail}>{room.detail}</Text></View>{roomId === room.id ? <Check color={colors.amberText} size={18} /> : null}</Pressable>)}
            <Text style={styles.sheetLabel}>DIRECT MESSAGES</Text>
            <TextInput accessibilityLabel="Search chat members" value={roomSearch} onChangeText={setRoomSearch} placeholder="Search people or roles" placeholderTextColor={colors.textFaint} style={styles.sheetInput} />
            <ScrollView contentContainerStyle={styles.memberList} keyboardShouldPersistTaps="handled">
              {memberSearchResults.map((member) => {
                const memberRoom = directMessageRoom(currentUserId ?? "", member.userId);
                return <Pressable key={member.userId} onPress={() => { router.setParams({ room: memberRoom, message: "" }); setRoomPickerOpen(false); }} style={[styles.roomChoice, roomId === memberRoom && styles.roomChoiceActive]}><View style={styles.avatar}><Text style={styles.avatarText}>{member.name.slice(0, 1).toUpperCase()}</Text></View><View style={styles.roomChoiceCopy}><Text style={styles.roomChoiceName}>{member.name}</Text><Text style={styles.roomChoiceDetail}>{member.role}</Text></View>{roomId === memberRoom ? <Check color={colors.amberText} size={18} /> : null}</Pressable>;
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setShareOpen(false)} transparent visible={shareOpen}>
        <Pressable onPress={() => setShareOpen(false)} style={styles.modalBackdrop}>
          <Pressable onPress={() => undefined} style={styles.sheet}>
            <View style={styles.sheetHeader}><View><Text style={styles.sheetEyebrow}>{roomId === "planning" ? "TARGETED ACCESS" : "GUEST ACCESS"}</Text><Text style={styles.sheetTitle}>{roomId === "planning" ? "Share Planning Room" : "Invite guest crew"}</Text></View><Pressable accessibilityLabel="Close invite" onPress={() => setShareOpen(false)}><X color={colors.textMuted} size={22} /></Pressable></View>
            <Text style={styles.shareDescription}>{roomId === "planning" ? "Only selected signed-in members can use this expiring link." : "Anyone with this expiring link can join Production Chat as a guest."}</Text>
            <Text style={styles.sheetLabel}>LINK EXPIRES IN</Text>
            <View style={styles.hourChoices}>{[1, 4, 8, 12, 24].map((hours) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: shareHours === hours }} key={hours} onPress={() => setShareHours(hours)} style={[styles.hourChoice, shareHours === hours && styles.typeChoiceActive]}><Text style={[styles.hourChoiceText, shareHours === hours && styles.typeChoiceTextActive]}>{hours}h</Text></Pressable>)}</View>
            {roomId === "planning" ? <>
              <Text style={styles.sheetLabel}>SELECT MEMBERS</Text>
              <ScrollView contentContainerStyle={styles.shareMembers}>
                {members.filter((member) => member.userId !== currentUserId).map((member) => {
                  const selected = selectedShareMemberIds.includes(member.userId);
                  return <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} key={member.userId} onPress={() => setSelectedShareMemberIds((current) => selected ? current.filter((userId) => userId !== member.userId) : [...current, member.userId])} style={[styles.roomChoice, selected && styles.roomChoiceActive]}><View style={[styles.shareCheck, selected && styles.shareCheckSelected]}>{selected ? <Check color={colors.black} size={12} strokeWidth={3} /> : null}</View><View style={styles.roomChoiceCopy}><Text style={styles.roomChoiceName}>{member.name}</Text><Text style={styles.roomChoiceDetail}>{member.role}</Text></View></Pressable>;
                })}
              </ScrollView>
            </> : null}
            <Pressable accessibilityLabel="Create and share chat invitation" accessibilityRole="button" accessibilityState={{ busy: sharing, disabled: sharing || (roomId === "planning" && selectedShareMemberIds.length === 0) }} disabled={sharing || (roomId === "planning" && selectedShareMemberIds.length === 0)} onPress={() => void createAndShareInvite()} style={[styles.pollSend, (sharing || (roomId === "planning" && selectedShareMemberIds.length === 0)) && styles.disabled]}>{sharing ? <ActivityIndicator color={colors.black} /> : <Text style={styles.pollSendText}>Create and share link</Text>}</Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setActionTarget(null)} transparent visible={Boolean(actionTarget)}>
        <Pressable onPress={() => setActionTarget(null)} style={styles.modalBackdropCenter}>
          <Pressable onPress={() => undefined} style={styles.actionSheet}>
            <Text style={styles.reactionPickerTitle}>Message actions</Text>
            <Pressable onPress={() => { if (actionTarget) { setEditing(null); setReplyingTo(actionTarget); } setActionTarget(null); }} style={styles.actionButton}><CornerUpLeft color={colors.textMuted} size={17} /><Text style={styles.actionText}>Reply</Text></Pressable>
            <Pressable onPress={() => { setReactionTarget(actionTarget); setActionTarget(null); }} style={styles.actionButton}><Text style={styles.actionEmoji}>👍</Text><Text style={styles.actionText}>Add reaction</Text></Pressable>
            {actionTarget?.senderId === currentUserId ? <>
              <Pressable onPress={() => { if (actionTarget) { setReplyingTo(null); setEditing(actionTarget); setText(actionTarget.text); } setActionTarget(null); }} style={styles.actionButton}><Pencil color={colors.textMuted} size={17} /><Text style={styles.actionText}>Edit message</Text></Pressable>
              <Pressable onPress={() => { if (actionTarget) confirmDelete(actionTarget); }} style={styles.actionButton}><Trash2 color={colors.red} size={17} /><Text style={[styles.actionText, styles.actionDanger]}>Delete message</Text></Pressable>
            </> : null}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setReactionTarget(null)} transparent visible={Boolean(reactionTarget)}>
        <Pressable onPress={() => setReactionTarget(null)} style={styles.modalBackdropCenter}>
          <Pressable onPress={() => undefined} style={styles.reactionPicker}>
            <Text style={styles.reactionPickerTitle}>React to message</Text>
            <View style={styles.reactionPickerRow}>{mobileChatReactionEmojis.map((emoji) => <Pressable accessibilityLabel={`React ${emoji}`} key={emoji} onPress={() => reactionTarget && void toggleReaction(reactionTarget, emoji)} style={styles.reactionPickerChoice}><Text style={styles.reactionPickerEmoji}>{emoji}</Text></Pressable>)}</View>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal animationType="slide" onRequestClose={() => setPollOpen(false)} transparent visible={pollOpen}>
        <Pressable onPress={() => setPollOpen(false)} style={styles.modalBackdrop}>
          <Pressable onPress={() => undefined} style={styles.sheet}>
            <View style={styles.sheetHeader}><View><Text style={styles.sheetEyebrow}>QUICK POLL</Text><Text style={styles.sheetTitle}>Ask the crew</Text></View><Pressable accessibilityLabel="Close poll" onPress={() => setPollOpen(false)}><X color={colors.textMuted} size={22} /></Pressable></View>
            <Text style={styles.sheetLabel}>QUESTION</Text>
            <TextInput maxLength={240} value={pollQuestion} onChangeText={setPollQuestion} placeholder="What should the team decide?" placeholderTextColor={colors.textFaint} style={styles.sheetInput} />
            <Text style={styles.sheetLabel}>OPTIONS</Text>
            {pollOptions.map((option, index) => <TextInput key={index} maxLength={120} value={option} onChangeText={(value) => setPollOptions((current) => current.map((item, optionIndex) => optionIndex === index ? value : item))} placeholder={`Option ${index + 1}`} placeholderTextColor={colors.textFaint} style={styles.sheetInput} />)}
            {pollOptions.length < 6 ? <Pressable onPress={() => setPollOptions((current) => [...current, ""])} style={styles.addOption}><Text style={styles.addOptionText}>+ Add option</Text></Pressable> : null}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !pollQuestion.trim() || pollOptions.filter((option) => option.trim()).length < 2 }} disabled={!pollQuestion.trim() || pollOptions.filter((option) => option.trim()).length < 2} onPress={sendPoll} style={[styles.pollSend, (!pollQuestion.trim() || pollOptions.filter((option) => option.trim()).length < 2) && styles.disabled]}><Text style={styles.pollSendText}>Send poll</Text></Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles((colors) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.stage },
  roomHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  roomSwitcher: { minWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  roomIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.amberSoft },
  roomCopy: { flex: 1, gap: 3 },
  roomTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "800" },
  roomSubtitle: { color: colors.textMuted, fontFamily, fontSize: 11 },
  connection: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800", textTransform: "uppercase" },
  connected: { color: colors.green },
  shareButton: { minHeight: 30, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, paddingHorizontal: 9 },
  shareButtonText: { color: colors.amberText, fontFamily, fontSize: 8, fontWeight: "900", letterSpacing: 0.7 },
  error: { color: colors.red, fontFamily, fontSize: 11 },
  liveStatus: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 7, borderRadius: radii.small, borderWidth: 1, borderColor: colors.redBorder, backgroundColor: colors.redSoft, paddingHorizontal: 10 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.red },
  liveLabel: { color: colors.red, fontFamily, fontSize: 8, fontWeight: "900", letterSpacing: 0.8 },
  liveItem: { flex: 1, color: colors.text, fontFamily, fontSize: 10, fontWeight: "800" },
  list: { flex: 1, marginHorizontal: -spacing.large },
  listContent: { flexGrow: 1, justifyContent: "flex-end", gap: 8, paddingHorizontal: spacing.large, paddingVertical: spacing.small },
  message: { alignSelf: "flex-start", maxWidth: "90%", gap: 6, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.stageRaised, padding: 12 },
  messageOwn: { alignSelf: "flex-end", borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  messageAlert: { borderColor: colors.redBorder, backgroundColor: colors.redSoft },
  messageCue: { borderColor: colors.blue, backgroundColor: colors.stageRaised },
  messageFocused: { borderWidth: 2, borderColor: colors.amber },
  messageHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  sender: { color: colors.text, fontFamily, fontSize: 10, fontWeight: "900" },
  role: { color: colors.textFaint, fontFamily, fontSize: 8, fontWeight: "800", textTransform: "uppercase" },
  alertBadge: { color: colors.red, fontFamily, fontSize: 8, fontWeight: "900", textTransform: "uppercase" },
  cueBadge: { color: colors.blue, fontFamily, fontSize: 8, fontWeight: "900", textTransform: "uppercase" },
  time: { marginLeft: "auto", color: colors.textFaint, fontFamily, fontSize: 8 },
  messageText: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20 },
  deleted: { color: colors.textFaint, fontStyle: "italic" },
  edited: { alignSelf: "flex-end", color: colors.textFaint, fontFamily, fontSize: 8, fontStyle: "italic" },
  seen: { alignSelf: "flex-end", color: colors.amberText, fontFamily, fontSize: 8, fontWeight: "700" },
  replyReference: { gap: 2, borderLeftWidth: 2, borderLeftColor: colors.amber, backgroundColor: colors.panel, paddingHorizontal: 8, paddingVertical: 6 },
  replySender: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800" },
  replyText: { color: colors.textMuted, fontFamily, fontSize: 10, lineHeight: 14 },
  attachment: { minWidth: 220, overflow: "hidden", flexDirection: "row", alignItems: "center", gap: 9, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 8 },
  attachmentImage: { width: 210, height: 140, borderRadius: radii.small, backgroundColor: colors.panelStrong },
  attachmentCopy: { minWidth: 0, flex: 1, gap: 2 },
  attachmentName: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "700" },
  attachmentMeta: { color: colors.textFaint, fontFamily, fontSize: 8 },
  poll: { gap: 7, borderTopWidth: 1, borderTopColor: colors.borderSoft, paddingTop: 8 },
  pollQuestion: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  pollOption: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10 },
  pollOptionSelected: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  pollCheck: { width: 17, height: 17, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 1, borderColor: colors.border },
  pollCheckSelected: { borderColor: colors.amber, backgroundColor: colors.amber },
  pollCheckMark: { color: colors.black },
  pollOptionText: { flex: 1, color: colors.text, fontFamily, fontSize: 11 },
  pollCount: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "800" },
  reactions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  reaction: { minHeight: 27, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 8 },
  reactionSelected: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  reactionText: { color: colors.text, fontFamily, fontSize: 11 },
  reactionAdd: { width: 27, height: 27, alignItems: "center", justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  reactionAddText: { color: colors.textMuted, fontFamily, fontSize: 15 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", marginVertical: 50 },
  olderButton: { alignSelf: "center", minHeight: 36, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 14, marginBottom: 8 },
  olderText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  typing: { color: colors.textMuted, fontFamily, fontSize: 10, fontStyle: "italic", marginBottom: 4 },
  composerContext: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, backgroundColor: colors.panel, padding: 8 },
  composerContextCopy: { flex: 1, gap: 2 },
  composerContextTitle: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "800" },
  composerContextText: { color: colors.textMuted, fontFamily, fontSize: 10 },
  pendingAttachment: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, backgroundColor: colors.amberSoft, padding: 8 },
  pendingAttachmentName: { flex: 1, color: colors.text, fontFamily, fontSize: 10, fontWeight: "700" },
  mentions: { maxHeight: 180, gap: 2, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 5 },
  mention: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, paddingHorizontal: 9 },
  mentionName: { flex: 1, color: colors.text, fontFamily, fontSize: 11, fontWeight: "800" },
  mentionRole: { color: colors.textMuted, fontFamily, fontSize: 9, textTransform: "uppercase" },
  composerTools: { flexDirection: "row", alignItems: "center", gap: 5, paddingTop: 5 },
  typeChoice: { minHeight: 28, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9 },
  typeChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  typeChoiceText: { color: colors.textMuted, fontFamily, fontSize: 8, fontWeight: "800", textTransform: "uppercase" },
  typeChoiceTextActive: { color: colors.amberText },
  toolButton: { minWidth: 32, height: 28, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  pollTool: { color: colors.textMuted, fontFamily, fontSize: 7, fontWeight: "900" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 9, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.small },
  input: { flex: 1, maxHeight: 110, minHeight: 44, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, paddingHorizontal: 13, paddingVertical: 11 },
  send: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.amber },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBackdropCenter: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.overlay, padding: spacing.large },
  sheet: { maxHeight: "88%", gap: 12, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large, paddingBottom: spacing.large + 12 },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetEyebrow: { color: colors.amberText, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1.3 },
  sheetTitle: { color: colors.text, fontFamily, fontSize: 19, fontWeight: "900" },
  sheetLabel: { color: colors.textMuted, fontFamily, fontSize: 9, fontWeight: "900", letterSpacing: 1.1, marginTop: 4 },
  sheetInput: { minHeight: 44, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 13, paddingHorizontal: 12 },
  roomChoice: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, paddingHorizontal: 12 },
  roomChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  roomChoiceCopy: { flex: 1, gap: 2 },
  roomChoiceName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  roomChoiceDetail: { color: colors.textMuted, fontFamily, fontSize: 9, textTransform: "capitalize" },
  memberList: { gap: 6, paddingBottom: 12 },
  shareDescription: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  hourChoices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  hourChoice: { minWidth: 46, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  hourChoiceText: { color: colors.textMuted, fontFamily, fontSize: 10, fontWeight: "800" },
  shareMembers: { maxHeight: 260, gap: 6 },
  shareCheck: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: colors.border },
  shareCheckSelected: { borderColor: colors.amber, backgroundColor: colors.amber },
  avatar: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 17, backgroundColor: colors.amberSoft },
  avatarText: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "900" },
  reactionPicker: { width: "100%", maxWidth: 360, gap: 14, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  actionSheet: { width: "100%", maxWidth: 360, gap: 7, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  actionButton: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.small, backgroundColor: colors.panel, paddingHorizontal: 12 },
  actionText: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  actionDanger: { color: colors.red },
  actionEmoji: { width: 17, textAlign: "center", fontSize: 15 },
  reactionPickerTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "900", textAlign: "center" },
  reactionPickerRow: { flexDirection: "row", justifyContent: "space-between" },
  reactionPickerChoice: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 24, backgroundColor: colors.panel },
  reactionPickerEmoji: { fontSize: 23 },
  addOption: { alignSelf: "flex-start", minHeight: 34, justifyContent: "center", paddingHorizontal: 4 },
  addOptionText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  pollSend: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, backgroundColor: colors.amber },
  pollSendText: { color: colors.black, fontFamily, fontSize: 12, fontWeight: "900" },
}));
