import { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { AppField } from "./app-field";
import { createThemedStyles, fontFamily } from "../theme/tokens";
export function CueChoice({ label, value, options, onChange, disabled = false }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean;
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const selection = options.find(option => option.value === value);
  return <View style={styles.group}>
    <Text style={styles.text}>{label}</Text>
    <AppButton label={selection?.label ?? (value ? "Selection unavailable — choose again" : `Choose ${label.toLowerCase()}`)} accessibilityLabel={`Choose ${label.toLowerCase()}`} variant="secondary" disabled={disabled || !options.length} onPress={() => { setSearch(""); setOpen(true); }} />
    <Modal visible={open && !disabled} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.backdrop}><View style={styles.dialog} accessibilityViewIsModal>
        <Text accessibilityRole="header" style={styles.heading}>{label}</Text>
        <AppField label={`Search ${label.toLowerCase()}`} value={search} onChangeText={setSearch} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.group}>
          {options.filter(option => option.label.toLowerCase().includes(search.toLowerCase())).map(option => <AppButton key={option.value} label={option.label}
            variant={value === option.value ? "primary" : "secondary"} onPress={() => { onChange(option.value); setOpen(false); }} />)}
          {!options.some(option => option.label.toLowerCase().includes(search.toLowerCase())) ? <Text style={styles.text}>No matching choices.</Text> : null}
        </ScrollView>
        <AppButton label="Close choices" variant="secondary" onPress={() => setOpen(false)} />
      </View></View>
    </Modal>
  </View>;
}
const useStyles = createThemedStyles(colors => StyleSheet.create({
  group: { gap: 10 }, text: { color: colors.text, fontFamily, fontSize: 14, lineHeight: 20 },
  heading: { color: colors.text, fontFamily, fontSize: 20, fontWeight: "700" },
  backdrop: { flex: 1, padding: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.65)" },
  dialog: { width: "100%", maxWidth: 560, maxHeight: "90%", padding: 16, gap: 12, borderRadius: 18, backgroundColor: colors.panel },
}));
