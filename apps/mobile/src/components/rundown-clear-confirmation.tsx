import { useState } from "react";
import { Text, View } from "react-native";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";

export function RundownClearConfirmation({
  title,
  count,
  revision,
  playing,
  active,
  onClose,
  onConfirm,
}: {
  title: string;
  count: number;
  revision: number;
  playing: boolean;
  active: boolean;
  onClose: () => void;
  onConfirm: (revision: number) => void;
}) {
  const { colors } = useAppTheme();
  const [reviewed, setReviewed] = useState({ title, count, revision, playing });
  const changed = reviewed.revision !== revision || reviewed.title !== title;
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 };
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderWidth: 1,
        borderColor: colors.redBorder,
        borderRadius: 14,
      }}
    >
      <Text style={{ ...text, fontWeight: "700" }}>
        Clear “{reviewed.title}”?
      </Text>
      <Text style={text}>
        This removes all {reviewed.count} items for every operator. There is no
        undo for clearing a rundown. Save a template first if you need a copy.
      </Text>
      {reviewed.playing ? (
        <Text style={{ ...text, color: colors.red }}>
          This show has an active timer. Clearing the rundown stops it.
        </Text>
      ) : null}
      {changed ? (
        <>
          <Text accessibilityRole="alert" style={text}>
            The rundown changed. Review it again before clearing.
          </Text>
          <AppButton
            label="Review current rundown"
            variant="secondary"
            disabled={!active}
            onPress={() => setReviewed({ title, count, revision, playing })}
          />
        </>
      ) : null}
      {!active ? (
        <Text accessibilityRole="alert" style={text}>
          Reconnect with editing access and resolve any previous rundown action
          first.
        </Text>
      ) : null}
      <AppButton label="Keep rundown" variant="secondary" onPress={onClose} />
      <AppButton
        label="Confirm clear rundown"
        variant="danger"
        disabled={!active || changed || count === 0}
        onPress={() => {
          if (active && !changed && count > 0) onConfirm(reviewed.revision);
        }}
      />
    </View>
  );
}
