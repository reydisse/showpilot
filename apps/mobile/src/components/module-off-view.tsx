import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { WORKSPACE_MODULES, type ModuleId } from "@showpilot/shared";
import {
  useWorkspace,
  useWorkspaceUpdate,
} from "@/providers/workspace-provider";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { saveMobileWorkspaceModules } from "@/lib/mobile-api";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";
export function ModuleOffView({ module }: { module: ModuleId }) {
  const workspace = useWorkspace();
  const update = useWorkspaceUpdate();
  const { organization, data } = useMobileBootstrap();
  const { colors } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canManage =
    (data?.identity.role === "owner" || data?.identity.role === "admin") &&
    data.identity.permissions.includes("settings:organization");
  return (
    <View style={{ padding: 24, gap: 16 }}>
      <Text
        accessibilityRole="header"
        style={{ color: colors.text, fontSize: 24, fontWeight: "700" }}
      >
        {WORKSPACE_MODULES[module]} is turned off for this workspace.
      </Text>
      <Text style={{ color: colors.textMuted }}>
        {canManage
          ? "Your content is still here. Enable this feature to open it."
          : "Ask an admin to turn it on."}
      </Text>
      <AppButton
        label="Back to operations"
        variant="secondary"
        onPress={() => router.replace("/(app)/operations")}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.red }}>
          {error}
        </Text>
      ) : null}
      {canManage && organization ? (
        <AppButton
          label={`Enable ${WORKSPACE_MODULES[module]}`}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            try {
              update(
                await saveMobileWorkspaceModules({
                  orgId: organization.id,
                  modules: [...workspace.modules, module],
                }),
              );
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "Could not enable this feature",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </View>
  );
}
