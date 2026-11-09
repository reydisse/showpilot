import { useState } from "react";
import { Modal, ScrollView, Text, View } from "react-native";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";

export function RundownResetConfirmation({
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
  const [reviewed, setReviewed] = useState({ title, count, revision });
  const changed = revision !== reviewed.revision || title !== reviewed.title;
  const text = { color: colors.text, fontSize: 14, lineHeight: 20 };
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          backgroundColor: "#00000088",
          justifyContent: "center",
          padding: 16,
        }}
      >
        <ScrollView
          style={{
            flexGrow: 0,
            maxHeight: "100%",
            width: "100%",
            maxWidth: 560,
            alignSelf: "center",
            backgroundColor: colors.panel,
            borderRadius: 14,
          }}
        >
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
              Reset timing for “{reviewed.title}”?
            </Text>
            <Text style={text}>
              This marks all {reviewed.count} items upcoming and clears their
              actual start and end times. It stops the paused timer and discards
              elapsed time for every operator. The items and show details stay
              in place. This cannot be undone.
            </Text>
            {playing ? (
              <Text
                accessibilityRole="alert"
                style={{ ...text, color: colors.red }}
              >
                Pause or stop the show before resetting timing.
              </Text>
            ) : null}
            {changed ? (
              <>
                <Text accessibilityRole="alert" style={text}>
                  The rundown changed. Review its current timing before
                  resetting.
                </Text>
                <AppButton
                  label="Review current timing"
                  variant="secondary"
                  disabled={!active || playing}
                  onPress={() => setReviewed({ title, count, revision })}
                />
              </>
            ) : null}
            {!active ? (
              <Text accessibilityRole="alert" style={text}>
                Reconnect with rundown control access and resolve any previous
                rundown action first.
              </Text>
            ) : null}
            <AppButton
              label="Keep timing"
              variant="secondary"
              onPress={onClose}
            />
            <AppButton
              label="Confirm timing reset"
              variant="danger"
              disabled={!active || playing || changed}
              onPress={() => {
                if (active && !playing && !changed)
                  onConfirm(reviewed.revision);
              }}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
