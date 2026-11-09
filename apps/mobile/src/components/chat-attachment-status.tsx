import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChatAttachmentWork } from "@showpilot/shared/chat-attachment-draft";
import { createThemedStyles, fontFamily } from "@/theme/tokens";

export function ChatAttachmentStatus({ items, retry, remove }: {
  items: ChatAttachmentWork[]; retry: (id: string) => void; remove: (id: string) => void;
}) {
  const styles = useStyles();
  if (!items.length) return null;
  return <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">{items.map(item => <View key={item.id} testID={`chat-attachment-${item.id}`} style={styles.row}>
    <Text style={styles.name}>{item.name}</Text>
    <Text style={styles.status}>{label(item)} · {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
    {(item.state === "upload-failed" || item.state === "remove-failed") && <Text accessibilityRole="alert" style={styles.error}>{item.error}</Text>}
    <View style={styles.buttons}>
      {(item.state === "upload-failed" || item.state === "remove-failed") && <Pressable accessibilityRole="button" accessibilityLabel={`${item.state === "remove-failed" ? "Retry removing" : "Retry uploading"} ${item.name}`} onPress={() => retry(item.id)} style={styles.button}><Text style={styles.buttonText}>{item.state === "remove-failed" ? "Retry removal" : "Retry upload"}</Text></Pressable>}
      {item.state !== "removing" && item.state !== "remove-failed" && item.state !== "sending" && <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${item.name}`} onPress={() => remove(item.id)} style={styles.button}><Text style={styles.buttonText}>Remove</Text></Pressable>}
    </View>
  </View>)}</ScrollView>;
}
function label(item: ChatAttachmentWork): string {
  switch (item.state) {
    case "preparing": return "Preparing";
    case "uploading": return "Uploading";
    case "ready": return "Ready to send";
    case "sending": return "Adding to message";
    case "upload-failed": return "Upload not confirmed";
    case "removing": return "Removing";
    case "remove-failed": return "Removal not confirmed";
  }
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  list: { maxHeight: 170, flexShrink: 1 },
  row: { padding: 8, gap: 5, borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  name: { fontFamily, color: colors.text, fontSize: 13 }, status: { fontFamily, color: colors.textMuted, fontSize: 12 },
  error: { fontFamily, color: colors.red, fontSize: 13 }, buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  button: { minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 },
  buttonText: { fontFamily, color: colors.text, fontSize: 13 },
}));
