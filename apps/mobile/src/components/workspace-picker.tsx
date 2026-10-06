import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  WORKSPACE_TYPES,
  WORKSPACE_DEFINITIONS,
  type WorkspaceType,
} from "@showpilot/shared";
import Church from "lucide-react-native/icons/church";
import RadioTower from "lucide-react-native/icons/radio-tower";
import GraduationCap from "lucide-react-native/icons/graduation-cap";
import Drama from "lucide-react-native/icons/drama";
import SlidersHorizontal from "lucide-react-native/icons/sliders-horizontal";
import { useAppTheme } from "@/theme/tokens";
import { AppField } from "./app-field";
import { AppButton } from "./app-button";
const icons = { Church, RadioTower, GraduationCap, Drama, SlidersHorizontal };
export function WorkspacePicker({
  onSelect,
  busy,
}: {
  onSelect: (type: WorkspaceType, label?: string) => void;
  busy: boolean;
}) {
  const { colors } = useAppTheme();
  const [custom, setCustom] = useState<WorkspaceType | null>(null);
  const [label, setLabel] = useState("");
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: colors.text, fontSize: 26, fontWeight: "700" }}>
        What are you running?
      </Text>
      {WORKSPACE_TYPES.map((type) => {
        const Icon = icons[WORKSPACE_DEFINITIONS[type].icon];
        return (
          <Pressable
            key={type}
            accessibilityRole="button"
            disabled={busy}
            onPress={() =>
              WORKSPACE_DEFINITIONS[type].customizable
                ? setCustom(type)
                : onSelect(type)
            }
            style={{
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 14,
              padding: 16,
              minHeight: 72,
              gap: 6,
              flexDirection: "row",
              alignItems: "center",
            }}
          >
            <Icon color={colors.amberText} size={22} />
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ color: colors.text, fontWeight: "700" }}>
                {WORKSPACE_DEFINITIONS[type].label}
              </Text>
              <Text style={{ color: colors.textMuted }}>
                {WORKSPACE_DEFINITIONS[type].description}
              </Text>
            </View>
          </Pressable>
        );
      })}
      {custom ? (
        <>
          <AppField
            label="What do you call your productions?"
            value={label}
            onChangeText={setLabel}
            maxLength={80}
            placeholder="Northside Productions"
          />
          <AppButton
            label="Continue"
            loading={busy}
            onPress={() => onSelect(custom, label)}
          />
        </>
      ) : null}
      <Text style={{ color: colors.textMuted }}>
        You can change this anytime in Settings.
      </Text>
    </View>
  );
}
