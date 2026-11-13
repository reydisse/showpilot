import { router } from "expo-router";
import { Text, View } from "react-native";
import { WORKSPACE_MODULES, type ModuleId } from "@showpilot/shared";
import {
  useWorkspace,
} from "@/providers/workspace-provider";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useWorkspaceWork } from "@/hooks/use-workspace-work";
import { WorkspaceChangeNotice } from "./workspace-change-notice";
import { AppButton } from "./app-button";
import { useAppTheme } from "@/theme/tokens";
export function ModuleOffView({ module }: { module: ModuleId }) {
  const workspace = useWorkspace();
  const { organization, data } = useMobileBootstrap();
  const { colors } = useAppTheme();
  const canManage =
    (data?.identity.role === "owner" || data?.identity.role === "admin") &&
    data.identity.permissions.includes("settings:organization");
  const work = useWorkspaceWork({ orgId: organization?.id ?? "", userId: data?.identity.userId ?? "" }, workspace, !!canManage && !!organization);
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
      {canManage && <WorkspaceChangeNotice work={work} />}
      {canManage && organization ? (
        <AppButton
          label={`Enable ${WORKSPACE_MODULES[module]}`}
          disabled={work.locked}
          loading={work.attempt?.kind === "pending"}
          onPress={() => work.submit({ kind: "module", module, enabled: true })}
        />
      ) : null}
    </View>
  );
}
