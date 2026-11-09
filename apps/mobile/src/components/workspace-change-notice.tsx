import { Text, View } from "react-native";
import { workspaceChangeMessage } from "@showpilot/shared/workspace-change";
import type { WorkspaceWork } from "@/hooks/use-workspace-work";
import { useAppTheme } from "@/theme/tokens";
import { AppButton } from "./app-button";
export function WorkspaceChangeNotice({ work }: { work: WorkspaceWork }) {
  const { colors } = useAppTheme();
  const a = work.attempt;
  return <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
    {work.loading ? <Text style={{ color: colors.text }}>Loading current workspace settings…</Text> : null}
    {work.error ? <><Text accessibilityRole="alert" style={{ color: colors.red }}>{work.error}</Text><AppButton label="Reload workspace" onPress={work.load} /></> : null}
    {work.notice ? <Text style={{ color: colors.text }}>{work.notice}</Text> : null}
    {a?.kind === "pending" ? <Text style={{ color: colors.text }}>Confirming workspace change…</Text> : null}
    {a?.kind === "unknown" ? <>
      <Text accessibilityRole="alert" style={{ color: colors.text }}>Workspace change is not confirmed. It may have saved. Your original change is kept.</Text>
      <AppButton label="Retry original change" onPress={work.retry} />
      <AppButton label="Check current settings" variant="secondary" onPress={work.review} />
    </> : null}
    {a?.kind === "confirmed" ? <>
      <Text style={{ color: colors.text }}>{workspaceChangeMessage(a.result)}</Text>
      {a.refresh === "pending" ? <Text style={{ color: colors.text }}>Refreshing workspace…</Text> : a.refresh === "failed" ? <>
        <Text accessibilityRole="alert" style={{ color: colors.text }}>The change is confirmed, but the workspace could not refresh.</Text>
        <AppButton label="Retry refresh" onPress={work.refresh} />
      </> : <AppButton label="Use current settings" onPress={work.useCurrent} />}
    </> : null}
  </View>;
}
