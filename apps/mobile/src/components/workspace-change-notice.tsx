import { FailureText } from "@/components/failure-text";
import { QuietActivity } from "@/components/quiet-activity";
import { Text, View } from "react-native";
import { workspaceChangeMessage } from "@showpilot/shared/workspace-change";
import type { WorkspaceWork } from "@/hooks/use-workspace-work";
import { useAppTheme } from "@/theme/tokens";
import { AppButton } from "./app-button";
export function WorkspaceChangeNotice({ work }: { work: WorkspaceWork }) {
  const { colors } = useAppTheme();
  const a = work.attempt;
  return <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
    {work.loading ? <QuietActivity /> : null}
    {work.error ? <><FailureText accessibilityRole="alert" style={{ color: colors.red }}>{work.error}</FailureText><AppButton label="Reload workspace" onPress={work.load} /></> : null}
    {work.notice ? <Text style={{ color: colors.text }}>{work.notice}</Text> : null}
    {a?.kind === "pending" ? <QuietActivity /> : null}
    {a?.kind === "unknown" ? <>
      <FailureText accessibilityRole="alert" style={{ color: colors.text }}>This change needs attention.</FailureText>
      <AppButton label="Retry original change" onPress={work.retry} />
      <AppButton label="Check current settings" variant="secondary" onPress={work.review} />
    </> : null}
    {a?.kind === "confirmed" ? <>
      <Text style={{ color: colors.text }}>{workspaceChangeMessage(a.result)}</Text>
      {a.refresh === "pending" ? <QuietActivity /> : a.refresh === "failed" ? <>
        <FailureText accessibilityRole="alert" style={{ color: colors.text }}>The workspace could not be updated.</FailureText>
        <AppButton label="Retry refresh" onPress={work.refresh} />
      </> : <AppButton label="Use current settings" onPress={work.useCurrent} />}
    </> : null}
  </View>;
}
