import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ArrowLeft from "lucide-react-native/icons/arrow-left";
import Check from "lucide-react-native/icons/check";
import ChevronDown from "lucide-react-native/icons/chevron-down";
import CornerUpLeft from "lucide-react-native/icons/corner-up-left";
import Hash from "lucide-react-native/icons/hash";
import ImageIcon from "lucide-react-native/icons/image";
import Pencil from "lucide-react-native/icons/pencil";
import Paperclip from "lucide-react-native/icons/paperclip";
import Send from "lucide-react-native/icons/send";
import Share2 from "lucide-react-native/icons/share-2";
import Trash2 from "lucide-react-native/icons/trash-2";
import X from "lucide-react-native/icons/x";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "@/lib/haptics";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
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
  blockMobileUser,
  downloadMobileChatAttachment,
  getMobileChatMembers,
  getMobileContentSafety,
  getMobileRundown,
  notifyMobileChatMessage,
  notifyMobileChatReaction,
  reportMobileContent,
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
  attachmentHeaders: Record<string, string>;
  currentUserId?: string;
  focused: boolean;
  message: MobileChatMessage;
  own: boolean;
  seen: boolean;
  onLongPress: (message: MobileChatMessage) => void;
  onOpenAttachment: (attachment: NonNullable<MobileChatMessage["attachments"]>[number]) => void;
  onToggleReaction: (message: MobileChatMessage, emoji: MobileChatReactionEmoji) => void;
  onVote: (messageId: string, optionId: string) => void;
  avatarUrl?: string | null;
  onReply: (message: MobileChatMessage) => void;
}

const MessageCard = memo(function MessageCard({
  attachmentHeaders,
  currentUserId,
  focused,
  message,
  own,
  seen,
  onLongPress,
  onOpenAttachment,
  onToggleReaction,
  onVote,
  avatarUrl,
  onReply,
}: MessageCardProps) {
  const styles = useStyles();
  const deleted = Boolean(message.deletedAt);
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => !deleted
      && gesture.dx > 10
      && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25,
    onPanResponderMove: (_event, gesture) => {
      translateX.setValue(Math.max(0, Math.min(72, gesture.dx)));
    },
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dx >= 54) {
        onReply(message);
        void Haptics.selectionAsync();
      }
      Animated.spring(translateX, { toValue: 0, damping: 18, stiffness: 240, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => {
      Animated.spring(translateX, { toValue: 0, damping: 18, stiffness: 240, useNativeDriver: true }).start();
    },
  }), [deleted, message, onReply, translateX]);
  return (
    <View style={styles.swipeContainer}>
      <View style={styles.swipeReplyAction}><CornerUpLeft color={styles.swipeReplyIcon.color} size={21} /><Text style={styles.swipeReplyText}>Reply</Text></View>
      <Animated.View style={[styles.swipeSurface, { transform: [{ translateX }] }]} {...swipeResponder.panHandlers}>
      <Pressable
        accessibilityHint="Swipe right to reply. Hold for more message actions."
        accessibilityLabel={`${own ? "You" : message.senderName}: ${readableChatText(message.text) || "attachment"}`}
        delayLongPress={350}
        onLongPress={() => onLongPress(message)}
        style={[
          styles.messageRow,
          own && styles.messageRowOwn,
          focused && styles.messageFocused,
        ]}
      >
      {!own ? (avatarUrl ? <Image source={{ uri: avatarUrl }} style={styles.avatarImage} /> : <View style={styles.avatarBubble}><Text style={styles.avatarBubbleText}>{message.senderName.trim().slice(0, 1).toUpperCase() || "?"}</Text></View>) : null}
      <View style={[styles.messageColumn, own && styles.messageColumnOwn]}>
        {!own ? <Text numberOfLines={1} style={styles.sender}>{message.senderName}</Text> : null}
        <View style={[
          styles.messageBubble,
          own && styles.messageBubbleOwn,
          message.type === "alert" && styles.messageBubbleAlert,
          message.type === "cue" && styles.messageBubbleCue,
        ]}>
        {message.type !== "text" ? <Text style={[styles.messageKindLabel, message.type === "alert" && styles.messageKindLabelAlert, own && styles.messageKindLabelOwn]}>{message.type}</Text> : null}
        {message.replyTo && !deleted ? (
          <View style={[styles.replyReference, own && styles.replyReferenceOwn]}>
            <Text numberOfLines={1} style={[styles.replySender, own && styles.replySenderOwn]}>{message.replyTo.senderName}</Text>
            <Text numberOfLines={1} style={[styles.replyText, own && styles.replyTextOwn]}>{readableChatText(message.replyTo.text)}</Text>
          </View>
        ) : null}
        {deleted || message.text ? <Text style={[styles.messageText, own && styles.messageTextOwn, deleted && styles.deleted]}>{deleted ? "Message deleted" : readableChatText(message.text)}</Text> : null}
        {!deleted && message.attachments?.map((attachment) => {
        const isImage = attachment.mimeType.startsWith("image/");
        return (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${attachment.name}`} key={attachment.id} onPress={() => onOpenAttachment(attachment)} style={[styles.attachment, own && styles.attachmentOwn]}>
            {isImage ? (
              <View style={styles.attachmentImageFrame}>
                <Image
                  resizeMode="cover"
                  source={{ uri: absoluteChatFileUrl(attachment.url), headers: attachmentHeaders }}
                  style={styles.attachmentImage}
                />
                <View pointerEvents="none" style={styles.attachmentOpenBadge}><ImageIcon color={styles.attachmentOpenIcon.color} size={15} /></View>
              </View>
            ) : <ImageIcon color={styles.attachmentName.color} size={20} />}
            {!isImage ? <View style={styles.attachmentCopy}>
              <Text numberOfLines={1} style={[styles.attachmentName, own && styles.attachmentNameOwn]}>{attachment.name}</Text>
              <Text style={[styles.attachmentMeta, own && styles.attachmentMetaOwn]}>{Math.max(1, Math.ceil(attachment.size / 1024))} KB · Tap to open</Text>
            </View> : null}
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
        </View>
        {!deleted && message.reactions?.some((reaction) => reaction.userIds.length > 0) ? (
          <View style={styles.reactions}>
            {message.reactions.filter((reaction) => reaction.userIds.length > 0).map((reaction) => {
            const selected = Boolean(currentUserId && reaction.userIds.includes(currentUserId));
            return (
              <Pressable accessibilityRole="button" accessibilityState={{ selected }} key={reaction.emoji} onPress={() => onToggleReaction(message, reaction.emoji)} style={[styles.reaction, selected && styles.reactionSelected]}>
                <Text style={styles.reactionText}>{reaction.emoji} {reaction.userIds.length}</Text>
              </Pressable>
            );
            })}
          </View>
        ) : null}
        <View style={[styles.messageMeta, own && styles.messageMetaOwn]}>
          {message.external ? <Text style={styles.gatewayBadge}>{message.external.platform}</Text> : null}
          <Text style={styles.time}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
          {message.editedAt && !deleted ? <Text style={styles.edited}>edited</Text> : null}
          {own && seen ? <Text style={styles.seen}>Seen</Text> : null}
        </View>
        {message.externalDelivery?.status === "pending" ? <Text style={styles.deliveryPending}>Sending to {message.externalDelivery.platform}…</Text> : null}
        {message.externalDelivery?.status === "failed" ? <Text style={styles.deliveryFailed}>Not delivered to {message.externalDelivery.platform}: {message.externalDelivery.error ?? "gateway unavailable"}</Text> : null}
      </View>
      </Pressable>
      </Animated.View>
    </View>
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
  const viewport = useWindowDimensions();
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
  const safetyQuery = useQuery({
    queryKey: ["mobile-content-safety", organization?.id],
    queryFn: () => getMobileContentSafety(organization!.id),
    enabled: Boolean(organization?.id),
    staleTime: 60_000,
  });
  const [text, setText] = useState("");
  const [messageType, setMessageType] = useState<MessageType>("text");
  const [replyingTo, setReplyingTo] = useState<MobileChatMessage | null>(null);
  const [editing, setEditing] = useState<MobileChatMessage | null>(null);
  const [attachment, setAttachment] = useState<MobileChatAttachment | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<MobileChatAttachment | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [roomSearch, setRoomSearch] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareHours, setShareHours] = useState(4);
  const [selectedShareMemberIds, setSelectedShareMemberIds] = useState<string[]>([]);
  const [sharing, setSharing] = useState(false);
  const [attachmentHeaders, setAttachmentHeaders] = useState<Record<string, string>>({});
  const [actionTarget, setActionTarget] = useState<MobileChatMessage | null>(null);
  const [reactionTarget, setReactionTarget] = useState<MobileChatMessage | null>(null);
  const listRef = useRef<FlatList<MobileChatMessage>>(null);
  const initialScrollDoneRef = useRef(false);
  const focusScrollDoneRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNotificationsRef = useRef(new Map<string, { text: string; mentionedUserIds: string[] }>());
  useEffect(() => {
    let active = true;
    void getNativeCookieHeader().then((headers) => {
      if (active) setAttachmentHeaders(headers);
    });
    return () => {
      active = false;
    };
  }, []);
  const members = useMemo(() => membersQuery.data?.members ?? [], [membersQuery.data?.members]);
  const memberImageById = useMemo(
    () => new Map(members.map((member) => [member.userId, member.image])),
    [members],
  );
  const currentUserId = membersQuery.data?.currentUserId ?? session?.user.id;
  const otherDmUserId = roomId.startsWith("dm:") ? roomParts.slice(1).find((userId) => userId !== currentUserId) : null;
  const dmMember = members.find((member) => member.userId === otherDmUserId);
  const roomTitle = roomId === "production" ? "Production Chat" : roomId === "planning" ? "Planning Room" : dmMember?.name ?? "Direct message";
  const gatewayLabel = relay.gatewayStatus.platform
    ? `${relay.gatewayStatus.platform[0].toUpperCase()}${relay.gatewayStatus.platform.slice(1)} ${relay.gatewayStatus.status === "connected" ? "synced" : relay.gatewayStatus.status}`
    : null;
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
  const visibleMessages = useMemo(() => {
    const blocked = new Set(safetyQuery.data?.blockedUserIds ?? []);
    return relay.messages.filter((message) => message.type !== "system" && (!message.senderId || !blocked.has(message.senderId)));
  }, [relay.messages, safetyQuery.data?.blockedUserIds]);
  const displayMessages = visibleMessages;

  useEffect(() => {
    initialScrollDoneRef.current = false;
    focusScrollDoneRef.current = null;
    stickToBottomRef.current = true;
    setReplyingTo(null);
    setEditing(null);
    setAttachment(null);
    setToolsOpen(false);
    pendingNotificationsRef.current.clear();
  }, [roomId]);

  const setRelayTyping = relay.setTyping;
  useEffect(() => () => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    setRelayTyping(false);
  }, [setRelayTyping]);

  useEffect(() => {
    if (!focusedMessageId || focusScrollDoneRef.current === focusedMessageId) return;
    const index = displayMessages.findIndex((message) => message.id === focusedMessageId);
    if (index < 0) return;
    focusScrollDoneRef.current = focusedMessageId;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ animated: true, index, viewPosition: 0.5 }));
  }, [displayMessages, focusedMessageId]);

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
    const replyTarget = replyingTo;
    const messageId = relay.send(text, messageType, {
      ...(replyTarget ? { replyTo: { messageId: replyTarget.id, senderName: replyTarget.senderName, text: replyTarget.text } } : {}),
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

  const shareAttachment = useCallback(async (file: MobileChatAttachment) => {
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
  }, []);

  const openAttachment = useCallback((file: MobileChatAttachment) => {
    if (file.mimeType.startsWith("image/")) {
      setPreviewAttachment(file);
      setPreviewUri(absoluteChatFileUrl(file.url));
      setPreviewLoading(true);
      return;
    }
    void shareAttachment(file);
  }, [shareAttachment]);

  function sendPoll() {
    const question = pollQuestion.trim();
    const options = pollOptions.map((option) => option.trim()).filter(Boolean);
    if (!question || options.length < 2) return;
    const replyTarget = replyingTo;
    const messageId = relay.send("", "text", {
      ...(replyTarget ? { replyTo: { messageId: replyTarget.id, senderName: replyTarget.senderName, text: replyTarget.text } } : {}),
      poll: { question, options },
    });
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

  const beginReply = useCallback((message: MobileChatMessage) => {
    setEditing(null);
    setReplyingTo(message);
    setActionTarget(null);
  }, []);

  const confirmDelete = useCallback((message: MobileChatMessage) => {
    setActionTarget(null);
    Alert.alert("Delete message?", "The message will remain in the conversation as deleted.", [
      { text: "Keep message", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteMessage(message.id).catch((error: Error) => Alert.alert("Message not deleted", error.message)) },
    ]);
  }, [deleteMessage]);

  const reportMessage = useCallback((message: MobileChatMessage) => {
    if (!organization) return;
    setActionTarget(null);
    const submit = (reason: "harassment" | "hate" | "sexual" | "violence" | "spam" | "other") => void reportMobileContent({
      orgId: organization.id,
      targetType: "chat-message",
      targetId: message.id,
      targetAuthorId: message.senderId,
      reason,
      details: message.text.slice(0, 500),
    }).then(() => Alert.alert("Report sent", "An organization administrator has been notified.")).catch((error: Error) => Alert.alert("Report not sent", error.message));
    Alert.alert("Report message", "Why are you reporting this message?", [
      { text: "Harassment", onPress: () => submit("harassment") },
      { text: "Hate or violence", onPress: () => submit("hate") },
      { text: "Spam or other", onPress: () => submit("spam") },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [organization]);

  const confirmBlock = useCallback((message: MobileChatMessage) => {
    if (!organization || !message.senderId) return;
    setActionTarget(null);
    Alert.alert(`Block ${message.senderName}?`, "Their messages will be hidden for you in this organization.", [
      { text: "Cancel", style: "cancel" },
      { text: "Block", style: "destructive", onPress: () => void blockMobileUser({ orgId: organization.id, blockedUserId: message.senderId! }).then(() => safetyQuery.refetch()).catch((error: Error) => Alert.alert("Person not blocked", error.message)) },
    ]);
  }, [organization, safetyQuery]);

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

  const openMessageAttachment = useCallback((file: MobileChatAttachment) => {
    void openAttachment(file);
  }, [openAttachment]);

  const toggleMessageReaction = useCallback((message: MobileChatMessage, emoji: MobileChatReactionEmoji) => {
    void toggleReaction(message, emoji);
  }, [toggleReaction]);

  const voteOnMessagePoll = useCallback((messageId: string, optionId: string) => {
    void votePoll(messageId, optionId).catch((error: Error) => Alert.alert("Vote not saved", error.message));
  }, [votePoll]);

  function trackScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickToBottomRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 96;
  }

  function keepLatestMessageVisible() {
    if (!displayMessages.length || focusedMessageId) return;
    if (!initialScrollDoneRef.current || stickToBottomRef.current) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: initialScrollDoneRef.current }));
    }
    initialScrollDoneRef.current = true;
  }

  const renderMessage = useCallback<ListRenderItem<MobileChatMessage>>(
    ({ item }) => (
        <MessageCard
          attachmentHeaders={attachmentHeaders}
          avatarUrl={item.senderId ? memberImageById.get(item.senderId) : null}
          currentUserId={currentUserId}
          focused={item.id === focusedMessageId}
          message={item}
          onLongPress={openMessageActions}
          onOpenAttachment={openMessageAttachment}
          onReply={beginReply}
          onToggleReaction={toggleMessageReaction}
          onVote={voteOnMessagePoll}
          own={item.senderId === currentUserId}
          seen={roomId.startsWith("dm:") && item.id === latestOwnMessageId && otherReadAt >= item.timestamp}
        />
    ),
    [attachmentHeaders, beginReply, currentUserId, focusedMessageId, latestOwnMessageId, memberImageById, openMessageActions, openMessageAttachment, otherReadAt, roomId, toggleMessageReaction, voteOnMessagePoll],
  );

  if (organizationPending) return <LoadingView label="Opening chat…" />;
  if (!organization) return <Redirect href="/organizations" />;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={0}>
      <Page scroll={false}>
        <View style={styles.roomHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Back to operations" onPress={() => router.canGoBack() ? router.back() : router.replace("/(app)/operations")} style={styles.backButton}><ArrowLeft color={colors.text} size={21} /></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Switch chat room. Current room: ${roomTitle}`} onPress={() => setRoomPickerOpen(true)} style={styles.roomSwitcher}>
              <View style={styles.roomCopy}><Text style={styles.roomTitle}>{roomTitle}</Text><Text numberOfLines={1} style={[styles.roomSubtitle, relay.status === "connected" && styles.connected]}>{relay.status === "connected" ? `● Connected${gatewayLabel ? ` · ${gatewayLabel}` : ""}` : relay.status}</Text></View>
              <ChevronDown color={colors.textMuted} size={17} />
            </Pressable>
            {membersQuery.data?.canInvite && !roomId.startsWith("dm:") ? <Pressable accessibilityRole="button" accessibilityLabel={roomId === "planning" ? "Share Planning Room" : "Invite guest crew"} onPress={() => { setSelectedShareMemberIds([]); setShareOpen(true); }} style={styles.shareButton}><Share2 color={colors.textMuted} size={18} /></Pressable> : null}
        </View>
        {relay.lastError ? <Text style={styles.error}>{relay.lastError}</Text> : null}
        {relay.gatewayStatus.status === "error" ? <Text style={styles.error}>External chat sync: {relay.gatewayStatus.error ?? "connection failed"}</Text> : null}
        {liveRundownQuery.data ? <LiveChatStatus detail={liveRundownQuery.data} orgId={organization.id} /> : null}
        <FlatList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={displayMessages}
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
        <View style={styles.composer}>
          {!editing ? <Pressable accessibilityRole="button" accessibilityLabel="Open message tools" onPress={() => setToolsOpen(true)} style={styles.composerToolButton}>{uploading ? <ActivityIndicator color={colors.textMuted} size="small" /> : <Paperclip color={colors.textMuted} size={20} />}</Pressable> : null}
          {messageType !== "text" && !editing ? <View style={[styles.composerTypeBadge, messageType === "alert" && styles.composerTypeBadgeAlert]}><Text style={[styles.composerTypeBadgeText, messageType === "alert" && styles.composerTypeBadgeTextAlert]}>{messageType}</Text></View> : null}
          <TextInput accessibilityLabel={`Message ${roomTitle}`} multiline maxLength={4000} value={text} onChangeText={updateText} placeholder={relay.status !== "connected" ? "Message will send when reconnected…" : `Message ${roomTitle}…`} placeholderTextColor={colors.textFaint} style={styles.input} />
          <Pressable accessibilityRole="button" accessibilityLabel={editing ? "Save edited message" : "Send message"} accessibilityState={{ disabled: !text.trim() && !attachment }} disabled={!text.trim() && !attachment} onPress={() => void submit()} style={({ pressed }) => [styles.send, !text.trim() && !attachment && styles.disabled, pressed && styles.pressed]}><Send color={colors.black} size={19} /></Pressable>
        </View>
      </Page>

      <Modal animationType="fade" onRequestClose={() => setPreviewAttachment(null)} visible={Boolean(previewAttachment)}>
        <View style={styles.imageViewer}>
          <View style={styles.imageViewerHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close image" onPress={() => setPreviewAttachment(null)} style={styles.imageViewerButton}><X color={colors.text} size={23} /></Pressable>
            <Text numberOfLines={1} style={styles.imageViewerTitle}>{previewAttachment?.name}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Share image" disabled={!previewAttachment || previewLoading} onPress={() => previewAttachment && void shareAttachment(previewAttachment)} style={styles.imageViewerButton}><Share2 color={colors.text} size={21} /></Pressable>
          </View>
          {previewLoading ? <View style={styles.imageViewerLoading}><ActivityIndicator color={colors.amber} size="large" /><Text style={styles.imageViewerLoadingText}>Opening image…</Text></View> : null}
          {previewUri ? (
            <ScrollView
              bouncesZoom
              centerContent
              contentContainerStyle={styles.imageViewerCanvas}
              maximumZoomScale={4}
              minimumZoomScale={1}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              style={styles.imageViewerScroll}
            >
              <Image
                onError={() => {
                  setPreviewLoading(false);
                  setPreviewAttachment(null);
                  setPreviewUri(null);
                  Alert.alert("Image not opened", "The image could not be loaded. Check your connection and try again.");
                }}
                onLoadEnd={() => setPreviewLoading(false)}
                resizeMode="contain"
                source={{ uri: previewUri, headers: attachmentHeaders }}
                style={{ width: viewport.width, height: Math.max(300, viewport.height - 92) }}
              />
            </ScrollView>
          ) : null}
        </View>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setToolsOpen(false)} transparent visible={toolsOpen}>
        <Pressable onPress={() => setToolsOpen(false)} style={styles.modalBackdropCenter}>
          <Pressable onPress={() => undefined} style={styles.toolsSheet}>
            <View style={styles.toolsHeader}><View><Text style={styles.sheetEyebrow}>MESSAGE TOOLS</Text><Text style={styles.toolsTitle}>What are you sending?</Text></View><Pressable accessibilityLabel="Close message tools" onPress={() => setToolsOpen(false)}><X color={colors.textMuted} size={21} /></Pressable></View>
            <View style={styles.messageKinds}>{(["text", "cue", "alert"] as const).map((type) => <Pressable accessibilityRole="radio" accessibilityState={{ checked: messageType === type }} key={type} onPress={() => setMessageType(type)} style={[styles.messageKind, messageType === type && styles.messageKindActive, type === "alert" && messageType === type && styles.messageKindAlert]}><Text style={[styles.messageKindText, messageType === type && styles.messageKindTextActive, type === "alert" && messageType === type && styles.messageKindTextAlert]}>{type === "text" ? "Message" : type}</Text></Pressable>)}</View>
            <View style={styles.toolsDivider} />
            <Pressable accessibilityRole="button" disabled={uploading} onPress={() => { setToolsOpen(false); void chooseAttachment(); }} style={styles.toolRow}><View style={styles.toolIcon}><ImageIcon color={colors.amberText} size={19} /></View><View style={styles.toolCopy}><Text style={styles.toolTitle}>Photo</Text><Text style={styles.toolDetail}>Choose an image from your library</Text></View></Pressable>
            <Pressable accessibilityRole="button" disabled={uploading} onPress={() => { setToolsOpen(false); void chooseDocument(); }} style={styles.toolRow}><View style={styles.toolIcon}><Text style={styles.toolIconText}>FILE</Text></View><View style={styles.toolCopy}><Text style={styles.toolTitle}>Document</Text><Text style={styles.toolDetail}>Attach a PDF, sheet, or document</Text></View></Pressable>
            <Pressable accessibilityRole="button" onPress={() => { setToolsOpen(false); setPollOpen(true); }} style={styles.toolRow}><View style={styles.toolIcon}><Text style={styles.toolIconText}>POLL</Text></View><View style={styles.toolCopy}><Text style={styles.toolTitle}>Quick poll</Text><Text style={styles.toolDetail}>Get a decision from the crew</Text></View></Pressable>
          </Pressable>
        </Pressable>
      </Modal>

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
            <Pressable onPress={() => actionTarget && beginReply(actionTarget)} style={styles.actionButton}><CornerUpLeft color={colors.textMuted} size={17} /><Text style={styles.actionText}>Reply</Text></Pressable>
            <Pressable onPress={() => { setReactionTarget(actionTarget); setActionTarget(null); }} style={styles.actionButton}><Text style={styles.actionEmoji}>👍</Text><Text style={styles.actionText}>Add reaction</Text></Pressable>
            {actionTarget?.senderId && actionTarget.senderId !== currentUserId ? <>
              <Pressable onPress={() => actionTarget && reportMessage(actionTarget)} style={styles.actionButton}><Text style={styles.actionEmoji}>⚑</Text><Text style={styles.actionText}>Report message</Text></Pressable>
              {!actionTarget.external ? <Pressable onPress={() => actionTarget && confirmBlock(actionTarget)} style={styles.actionButton}><Text style={styles.actionEmoji}>🚫</Text><Text style={[styles.actionText, styles.actionDanger]}>Block {actionTarget.senderName}</Text></Pressable> : null}
            </> : null}
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
            <ScrollView contentContainerStyle={styles.reactionPickerRow}>{mobileChatReactionEmojis.map((emoji) => <Pressable accessibilityLabel={`React ${emoji}`} key={emoji} onPress={() => reactionTarget && void toggleReaction(reactionTarget, emoji)} style={styles.reactionPickerChoice}><Text style={styles.reactionPickerEmoji}>{emoji}</Text></Pressable>)}</ScrollView>
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
  roomHeader: { minHeight: 46, flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, paddingBottom: 8 },
  roomSwitcher: { minWidth: 0, flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  backButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -10 },
  roomCopy: { flex: 1, gap: 2 },
  roomTitle: { color: colors.text, fontFamily, fontSize: 16, fontWeight: "900", letterSpacing: -0.2 },
  roomSubtitle: { color: colors.textMuted, fontFamily, fontSize: 11 },
  connection: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  connected: { color: colors.green },
  shareButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19, backgroundColor: colors.panelStrong },
  error: { color: colors.red, fontFamily, fontSize: 11 },
  liveStatus: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 7, borderBottomWidth: 1, borderBottomColor: colors.borderSoft, paddingHorizontal: 4 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green },
  liveLabel: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  liveItem: { flex: 1, color: colors.text, fontFamily, fontSize: 11, fontWeight: "800" },
  list: { flex: 1, marginHorizontal: -spacing.medium },
  listContent: { flexGrow: 1, justifyContent: "flex-end", paddingVertical: 8 },
  swipeContainer: { position: "relative", overflow: "hidden", backgroundColor: colors.stage },
  swipeReplyAction: { position: "absolute", left: 13, top: 0, bottom: 0, width: 48, alignItems: "center", justifyContent: "center", gap: 1 },
  swipeReplyIcon: { color: colors.amberText },
  swipeReplyText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "700" },
  swipeSurface: { backgroundColor: colors.stage },
  messageRow: { width: "100%", flexDirection: "row", alignItems: "flex-end", gap: 7, paddingHorizontal: 10, paddingVertical: 3 },
  messageRowOwn: { justifyContent: "flex-end" },
  messageFocused: { borderRadius: 18, backgroundColor: colors.amberSoft },
  avatarBubble: { width: 28, height: 28, flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.panelStrong },
  avatarImage: { width: 28, height: 28, flexShrink: 0, borderRadius: 14 },
  avatarBubbleText: { color: colors.amberText, fontFamily, fontSize: 12, fontWeight: "900" },
  messageColumn: { minWidth: 0, maxWidth: "82%", alignItems: "flex-start", gap: 3 },
  messageColumnOwn: { alignItems: "flex-end" },
  sender: { maxWidth: "100%", marginLeft: 10, color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "700" },
  messageBubble: { minWidth: 46, maxWidth: "100%", flexShrink: 1, overflow: "hidden", gap: 6, borderRadius: 18, borderBottomLeftRadius: 5, backgroundColor: colors.panelStrong, paddingHorizontal: 12, paddingVertical: 9 },
  messageBubbleOwn: { borderBottomLeftRadius: 18, borderBottomRightRadius: 5, backgroundColor: colors.amber },
  messageBubbleAlert: { borderWidth: 1, borderColor: colors.red, backgroundColor: colors.redSoft },
  messageBubbleCue: { borderWidth: 1, borderColor: colors.amberBorder },
  messageKindLabel: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  messageKindLabelAlert: { color: colors.red },
  messageKindLabelOwn: { color: colors.black },
  messageMeta: { flexDirection: "row", alignItems: "center", gap: 5, marginHorizontal: 7 },
  messageMetaOwn: { justifyContent: "flex-end" },
  gatewayBadge: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800", textTransform: "capitalize" },
  time: { color: colors.textFaint, fontFamily, fontSize: 11 },
  messageText: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20 },
  messageTextOwn: { color: colors.black },
  deleted: { color: colors.textFaint, fontStyle: "italic" },
  edited: { color: colors.textFaint, fontFamily, fontSize: 11, fontStyle: "italic" },
  seen: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "700" },
  replyReference: { gap: 1, borderLeftWidth: 2, borderLeftColor: colors.amber, paddingLeft: 7, paddingRight: 2, paddingVertical: 1 },
  replyReferenceOwn: { borderLeftColor: colors.black },
  replySender: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  replySenderOwn: { color: colors.black },
  replyText: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 14 },
  replyTextOwn: { color: colors.black },
  attachment: { width: 248, maxWidth: "100%", flexShrink: 1, overflow: "hidden", gap: 7, borderRadius: 12, backgroundColor: colors.stageRaised, padding: 5 },
  attachmentOwn: { backgroundColor: colors.stage },
  attachmentImageFrame: { position: "relative", width: "100%", height: 148, maxHeight: 148, overflow: "hidden", borderRadius: 9, backgroundColor: colors.panelStrong },
  attachmentImage: { ...StyleSheet.absoluteFillObject, width: undefined, height: undefined, backgroundColor: colors.panelStrong },
  attachmentOpenBadge: { position: "absolute", right: 8, bottom: 8, width: 30, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 15, backgroundColor: colors.overlay },
  attachmentOpenIcon: { color: colors.text },
  attachmentCopy: { minWidth: 0, flex: 1, gap: 2 },
  attachmentName: { color: colors.text, fontFamily, fontSize: 11, fontWeight: "700" },
  attachmentNameOwn: { color: colors.text },
  attachmentMeta: { color: colors.textFaint, fontFamily, fontSize: 11 },
  attachmentMetaOwn: { color: colors.textMuted },
  poll: { minWidth: 220, gap: 7, borderRadius: 12, backgroundColor: colors.stage, padding: 8 },
  pollQuestion: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  pollOption: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10 },
  pollOptionSelected: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  pollCheck: { width: 17, height: 17, alignItems: "center", justifyContent: "center", borderRadius: 9, borderWidth: 1, borderColor: colors.border },
  pollCheckSelected: { borderColor: colors.amber, backgroundColor: colors.amber },
  pollCheckMark: { color: colors.black },
  pollOptionText: { flex: 1, color: colors.text, fontFamily, fontSize: 11 },
  pollCount: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
  reactions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 },
  reaction: { minHeight: 27, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 8 },
  reactionSelected: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  reactionText: { color: colors.text, fontFamily, fontSize: 11 },
  deliveryPending: { maxWidth: 260, color: colors.textMuted, fontFamily, fontSize: 11 },
  deliveryFailed: { maxWidth: 260, color: colors.red, fontFamily, fontSize: 11, lineHeight: 15 },
  empty: { color: colors.textMuted, fontFamily, fontSize: 13, lineHeight: 20, textAlign: "center", marginVertical: 50 },
  olderButton: { alignSelf: "center", minHeight: 36, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 14, marginBottom: 8 },
  olderText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  typing: { color: colors.textMuted, fontFamily, fontSize: 11, fontStyle: "italic", marginBottom: 4 },
  composerContext: { flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: colors.borderSoft, paddingHorizontal: 6, paddingVertical: 7 },
  composerContextCopy: { flex: 1, gap: 2 },
  composerContextTitle: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  composerContextText: { color: colors.textMuted, fontFamily, fontSize: 11 },
  pendingAttachment: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, backgroundColor: colors.amberSoft, padding: 8 },
  pendingAttachmentName: { flex: 1, color: colors.text, fontFamily, fontSize: 11, fontWeight: "700" },
  mentions: { maxHeight: 180, gap: 2, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, padding: 5 },
  mention: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 8, borderRadius: radii.small, paddingHorizontal: 9 },
  mentionName: { flex: 1, color: colors.text, fontFamily, fontSize: 11, fontWeight: "800" },
  mentionRole: { color: colors.textMuted, fontFamily, fontSize: 11, textTransform: "uppercase" },
  typeChoice: { minHeight: 28, justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9 },
  typeChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  typeChoiceText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800", textTransform: "uppercase" },
  typeChoiceTextActive: { color: colors.amberText },
  pollTool: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900" },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 7, paddingTop: 6 },
  composerToolButton: { width: 38, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: colors.panelStrong },
  composerTypeBadge: { height: 30, alignSelf: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.amberBorder, backgroundColor: colors.amberSoft, paddingHorizontal: 8 },
  composerTypeBadgeAlert: { borderColor: colors.red, backgroundColor: colors.redSoft },
  composerTypeBadgeText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  composerTypeBadgeTextAlert: { color: colors.red },
  input: { flex: 1, maxHeight: 110, minHeight: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, color: colors.text, fontFamily, fontSize: 14, lineHeight: 19, paddingHorizontal: 14, paddingVertical: 9 },
  send: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 20, backgroundColor: colors.amber },
  imageViewer: { flex: 1, backgroundColor: colors.black },
  imageViewerHeader: { height: 72, flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 8, paddingBottom: 8, backgroundColor: colors.black },
  imageViewerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: colors.panelStrong },
  imageViewerTitle: { minWidth: 0, flex: 1, color: colors.text, fontFamily, fontSize: 13, fontWeight: "700", textAlign: "center", paddingBottom: 13 },
  imageViewerScroll: { flex: 1 },
  imageViewerCanvas: { flexGrow: 1, alignItems: "center", justifyContent: "center" },
  imageViewerLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  imageViewerLoadingText: { color: colors.textMuted, fontFamily, fontSize: 13 },
  disabled: { opacity: 0.38 },
  pressed: { opacity: 0.72 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBackdropCenter: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.overlay, padding: spacing.large },
  sheet: { maxHeight: "88%", gap: 12, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large, paddingBottom: spacing.large + 12 },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetEyebrow: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.3 },
  sheetTitle: { color: colors.text, fontFamily, fontSize: 19, fontWeight: "900" },
  sheetLabel: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", letterSpacing: 1.1, marginTop: 4 },
  sheetInput: { minHeight: 44, borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, color: colors.text, fontFamily, fontSize: 13, paddingHorizontal: 12 },
  roomChoice: { minHeight: 54, flexDirection: "row", alignItems: "center", gap: 10, borderRadius: radii.medium, borderWidth: 1, borderColor: colors.borderSoft, backgroundColor: colors.panel, paddingHorizontal: 12 },
  roomChoiceActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  roomChoiceCopy: { flex: 1, gap: 2 },
  roomChoiceName: { color: colors.text, fontFamily, fontSize: 12, fontWeight: "800" },
  roomChoiceDetail: { color: colors.textMuted, fontFamily, fontSize: 11, textTransform: "capitalize" },
  memberList: { gap: 6, paddingBottom: 12 },
  shareDescription: { color: colors.textMuted, fontFamily, fontSize: 11, lineHeight: 17 },
  hourChoices: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  hourChoice: { minWidth: 46, minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border },
  hourChoiceText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "800" },
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
  toolsSheet: { width: "100%", maxWidth: 380, gap: 8, borderRadius: radii.large, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.stageRaised, padding: spacing.large },
  toolsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 5 },
  toolsTitle: { color: colors.text, fontFamily, fontSize: 18, fontWeight: "900", letterSpacing: -0.2 },
  messageKinds: { flexDirection: "row", gap: 7 },
  messageKind: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radii.small, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  messageKindActive: { borderColor: colors.amberBorder, backgroundColor: colors.amberSoft },
  messageKindAlert: { borderColor: colors.red, backgroundColor: colors.redSoft },
  messageKindText: { color: colors.textMuted, fontFamily, fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
  messageKindTextActive: { color: colors.amberText },
  messageKindTextAlert: { color: colors.red },
  toolsDivider: { height: 1, backgroundColor: colors.borderSoft, marginVertical: 4 },
  toolRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: 11, borderRadius: radii.small, paddingHorizontal: 8 },
  toolIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.amberSoft },
  toolIconText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "900" },
  toolCopy: { flex: 1, gap: 2 },
  toolTitle: { color: colors.text, fontFamily, fontSize: 13, fontWeight: "800" },
  toolDetail: { color: colors.textMuted, fontFamily, fontSize: 11 },
  reactionPickerTitle: { color: colors.text, fontFamily, fontSize: 14, fontWeight: "900", textAlign: "center" },
  reactionPickerRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8, maxHeight: 264 },
  reactionPickerChoice: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: colors.panel },
  reactionPickerEmoji: { fontSize: 23 },
  addOption: { alignSelf: "flex-start", minHeight: 34, justifyContent: "center", paddingHorizontal: 4 },
  addOptionText: { color: colors.amberText, fontFamily, fontSize: 11, fontWeight: "800" },
  pollSend: { minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: radii.medium, backgroundColor: colors.amber },
  pollSendText: { color: colors.black, fontFamily, fontSize: 12, fontWeight: "900" },
}));
