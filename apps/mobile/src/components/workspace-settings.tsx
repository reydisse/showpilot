import { useState } from "react";
import { Linking, Pressable, Switch, Text, View } from "react-native";
import {
  WORKSPACE_TYPES,
  WORKSPACE_DEFINITIONS,
  MODULE_IDS,
  CORE_MODULES,
  WORKSPACE_MODULES,
} from "@showpilot/shared";
import {
  useWorkspace,
} from "@/providers/workspace-provider";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import { useWorkspaceWork } from "@/hooks/use-workspace-work";
import { WorkspaceChangeNotice } from "./workspace-change-notice";
import { runMobileOperation } from "@/lib/request-deadline";
import { SHOWPILOT_URL } from "@/lib/env";
import { useAppTheme } from "@/theme/tokens";
import { AppButton } from "./app-button";
export function WorkspaceSettings() {
  const profile = useWorkspace();
  const { organization, data } = useMobileBootstrap();
  const { colors } = useAppTheme();
  const [linkError, setLinkError] = useState("");
  const canManage = Boolean(
    (data?.identity.role === "owner" || data?.identity.role === "admin") &&
    data.identity.permissions.includes("settings:organization"),
  );
  const work = useWorkspaceWork({ orgId: organization?.id ?? "", userId: data?.identity.userId ?? "" }, profile, canManage && !!organization);
  const workspace = work.profile;
  const { type, reset, changing } = work.draft;
  const busy = work.locked;
  const edit = (next: Partial<typeof work.draft>) => work.edit({ ...work.draft, ...next });
  if (!organization) return null;
  return (
    <View
      style={{
        gap: 14,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>
        Workspace
      </Text>
      <Text style={{ color: colors.textMuted }}>
        {workspace.label || WORKSPACE_DEFINITIONS[workspace.type].label}
      </Text>
      {linkError ? (
        <Text accessibilityRole="alert" style={{ color: colors.red }}>
          {linkError}
        </Text>
      ) : null}
      {canManage && <WorkspaceChangeNotice work={work} />}
      {canManage ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {WORKSPACE_TYPES.map((id) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                edit({ type: id, reset: false, changing: true });
              }}
              style={{
                minHeight: 44,
                justifyContent: "center",
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: 8,
                padding: 10,
              }}
            >
              <Text style={{ color: colors.text }}>
                {WORKSPACE_DEFINITIONS[id].label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {changing ? (
        <>
          <Text style={{ color: colors.text }}>
            Change to {WORKSPACE_DEFINITIONS[type].label}? Names change. Nothing
            is deleted.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Switch
              accessibilityLabel={`Also reset features to ${WORKSPACE_DEFINITIONS[type].label} defaults`}
              disabled={busy}
              value={reset}
              onValueChange={reset => edit({ reset })}
            />
            <Text style={{ color: colors.text, flex: 1 }}>
              Also reset features to {WORKSPACE_DEFINITIONS[type].label}{" "}
              defaults
            </Text>
          </View>
          <AppButton
            label="Save type"
            loading={work.attempt?.kind === "pending"}
            disabled={busy}
            onPress={() => work.submit({ kind: "type", type, resetModules: reset })}
          />
          <AppButton label="Cancel" disabled={busy} onPress={() => edit({ changing: false })} />
        </>
      ) : null}
      <Text style={{ color: colors.textMuted }}>
        Core features stay on. Hidden features keep their content.
      </Text>
      {MODULE_IDS.map((id) => (
        <View
          key={id}
          style={{
            flexDirection: "row",
            minHeight: 48,
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Text style={{ color: colors.text, flex: 1 }}>
            {WORKSPACE_MODULES[id]}
            {CORE_MODULES.includes(id) ? " · Required" : ""}
          </Text>
          <Switch
            accessibilityLabel={WORKSPACE_MODULES[id]}
            disabled={!canManage || busy || CORE_MODULES.includes(id)}
            value={workspace.modules.includes(id)}
            onValueChange={enabled => work.submit({ kind: "module", module: id, enabled })}
          />
        </View>
      ))}
      {WORKSPACE_DEFINITIONS[workspace.type].customizable ? (
        <AppButton
          label="Edit names on the web"
          onPress={() => {
            setLinkError("");
            void runMobileOperation(async () => { await Linking.openURL(`${SHOWPILOT_URL}/${organization.slug}/settings?section=workspace`); }, undefined, 8000)
              .catch(() => setLinkError("Could not confirm opening Workspace settings. Try the web link again."));
          }}
        />
      ) : null}
    </View>
  );
}
