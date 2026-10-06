import { useState } from "react";
import { Linking, Pressable, Switch, Text, View } from "react-native";
import {
  WORKSPACE_TYPES,
  WORKSPACE_DEFINITIONS,
  MODULE_IDS,
  CORE_MODULES,
  WORKSPACE_MODULES,
  type WorkspaceType,
} from "@showpilot/shared";
import {
  useWorkspace,
  useWorkspaceUpdate,
} from "@/providers/workspace-provider";
import { useMobileBootstrap } from "@/hooks/use-mobile-bootstrap";
import {
  saveMobileWorkspaceType,
  saveMobileWorkspaceModules,
} from "@/lib/mobile-api";
import { SHOWPILOT_URL } from "@/lib/env";
import { useAppTheme } from "@/theme/tokens";
import { AppButton } from "./app-button";
export function WorkspaceSettings() {
  const workspace = useWorkspace();
  const update = useWorkspaceUpdate();
  const { organization, data } = useMobileBootstrap();
  const { colors } = useAppTheme();
  const [type, setType] = useState<WorkspaceType | null>(null);
  const [reset, setReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canManage = Boolean(
    (data?.identity.role === "owner" || data?.identity.role === "admin") &&
    data.identity.permissions.includes("settings:organization"),
  );
  async function save(work: () => Promise<typeof workspace>) {
    setBusy(true);
    setError("");
    try {
      update(await work());
      setType(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save workspace");
    } finally {
      setBusy(false);
    }
  }
  if (!organization) return null;
  const orgId = organization.id;
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
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.red }}>
          {error}
        </Text>
      ) : null}
      {canManage ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {WORKSPACE_TYPES.map((id) => (
            <Pressable
              key={id}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                setType(id);
                setReset(false);
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
      {type ? (
        <>
          <Text style={{ color: colors.text }}>
            Change to {WORKSPACE_DEFINITIONS[type].label}? Names change. Nothing
            is deleted.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Switch
              accessibilityLabel={`Also reset features to ${WORKSPACE_DEFINITIONS[type].label} defaults`}
              value={reset}
              onValueChange={setReset}
            />
            <Text style={{ color: colors.text, flex: 1 }}>
              Also reset features to {WORKSPACE_DEFINITIONS[type].label}{" "}
              defaults
            </Text>
          </View>
          <AppButton
            label="Save type"
            loading={busy}
            onPress={() =>
              void save(() =>
                saveMobileWorkspaceType({ orgId, type, resetModules: reset }),
              )
            }
          />
          <AppButton label="Cancel" onPress={() => setType(null)} />
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
            onValueChange={(enabled) =>
              void save(() =>
                saveMobileWorkspaceModules({
                  orgId,
                  modules: enabled
                    ? [...workspace.modules, id]
                    : workspace.modules.filter((value) => value !== id),
                }),
              )
            }
          />
        </View>
      ))}
      {WORKSPACE_DEFINITIONS[workspace.type].customizable ? (
        <AppButton
          label="Edit names on the web"
          onPress={() =>
            void Linking.openURL(
              `${SHOWPILOT_URL}/${organization.slug}/settings?section=workspace`,
            )
          }
        />
      ) : null}
    </View>
  );
}
