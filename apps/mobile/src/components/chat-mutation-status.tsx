import { ScrollView, StyleSheet, Text, View } from "react-native";
import { chatMutationSummary, chatMutationOutcomeMessage } from "@showpilot/shared/chat-mutation";
import type { ChatMutationWork } from "@showpilot/shared/chat-mutation-tracker";
import { AppButton } from "./app-button";
import { createThemedStyles, fontFamily } from "../theme/tokens";

export function ChatMutationStatus({ items, connected, retry, dismiss }: {
  items: ChatMutationWork[]; connected: boolean; retry(id: string): void; dismiss(id: string): void;
}) {
  const styles = useStyles();
  if (!items.length) return null;
  return <ScrollView style={styles.container} contentContainerStyle={styles.content} accessibilityLabel="Message changes">
    {items.map(item => <View key={item.command.requestId} style={styles.item} testID={`chat-mutation-${item.command.requestId}`}>
      <Text accessibilityRole={item.state !== "sending" ? "alert" : undefined} style={styles.title}>{item.state === "sending" ? "Confirming message change…" : item.state === "unknown" ? item.error : chatMutationOutcomeMessage(item.result)}</Text>
      <Text style={styles.detail}>{chatMutationSummary(item.command.operation)}</Text>
      <Text style={styles.detail}>Updated {new Date(item.at).toLocaleTimeString()}</Text>
      {item.state !== "sending" && (item.state === "unknown" || item.result.cleanup !== "complete") ? <AppButton label={item.state === "settled" ? "Retry attachment cleanup" : "Recover original change"} variant="secondary" disabled={!connected} onPress={() => retry(item.command.requestId)} /> : null}
      {item.state === "settled" && item.result.cleanup === "complete" ? <AppButton label="Dismiss result" variant="secondary" onPress={() => dismiss(item.command.requestId)} /> : null}
    </View>)}
  </ScrollView>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  container: { maxHeight: 220, flexShrink: 1 },
  content: { gap: 10, padding: 12 },
  item: { gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panelStrong },
  title: { fontFamily, color: colors.amberText, fontWeight: "700", fontSize: 14, lineHeight: 20 },
  detail: { fontFamily, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
}));
