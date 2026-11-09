import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ChatDelivery } from "../hooks/use-chat-relay";
import { AppButton } from "./app-button";
import { createThemedStyles, fontFamily } from "../theme/tokens";

export function ChatDeliveryStatus({ items, connected, retry, retryNotifications, discard }: {
  items: ChatDelivery[]; connected: boolean; retry: (id: string) => void; retryNotifications: (id: string) => void; discard: (id: string) => void;
}) {
  const styles = useStyles();
  const [review, setReview] = useState<string | null>(null);
  return <View style={styles.container}>
    {items.map(item => <View key={item.id} style={styles.item} testID={`chat-delivery-${item.id}`}>
      <Text style={styles.title}>{item.kind === "queued" ? "Queued, not sent" : item.kind === "sending" ? "Waiting for delivery confirmation…" : item.kind === "rejected" ? "Message rejected" : item.kind === "notifying" ? "Delivered · notifying crew…" : item.kind === "notification-failed" ? "Delivered · notifications need attention" : "Delivery not confirmed"}</Text>
      <Text style={styles.text}>{item.text}</Text>
      <Text accessibilityRole={item.kind === "uncertain" || item.kind === "rejected" || item.kind === "notification-failed" ? "alert" : undefined} style={styles.detail}>
        {item.kind === "queued" ? "This message will send when this room reconnects." : item.kind === "sending" ? "Keep this entry until the relay confirms delivery." : item.kind === "notifying" ? "The chat update is saved. Waiting for crew notification confirmation." : item.error}
      </Text>
      {item.kind === "uncertain" ? <AppButton label="Retry original message" variant="secondary" disabled={!connected} onPress={() => retry(item.id)} /> : null}
      {item.kind === "notification-failed" ? <AppButton label="Retry crew notifications" variant="secondary" disabled={!connected} onPress={() => retryNotifications(item.id)} /> : null}
      {review === item.id ? <View style={styles.list}>
        <Text style={styles.detail}>Remove this local entry? It may already have been delivered. This does not delete messages from chat.</Text>
        <AppButton label="Keep tracking message" variant="secondary" onPress={() => setReview(null)} />
        <AppButton label="Confirm remove from outbox" variant="danger" onPress={() => { discard(item.id); setReview(null); }} />
      </View> : <AppButton label="Remove from outbox" variant="secondary" onPress={() => setReview(item.id)} />}
    </View>)}
  </View>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  container: { gap: 12, paddingHorizontal: 12 },
  list: { gap: 12 },
  item: { gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong },
  title: { fontFamily, color: colors.amberText, fontWeight: "800", fontSize: 14, lineHeight: 20 },
  text: { fontFamily, color: colors.text, fontSize: 14, lineHeight: 20 },
  detail: { fontFamily, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
}));
