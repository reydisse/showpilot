import { useCallback, type ComponentProps } from "react";
import { getAutomationDeviceNames } from "@/lib/automation-targets";
import { isDeviceCue } from "@showpilot/shared";
import { useCueChoices } from "./useCueChoices";
import { AutomationTimeline } from "./AutomationTimeline";

/** Key by organization at the page boundary so names never cross workspace changes. */
export function AutomationTimelinePanel({ orgId, ...timeline }: Omit<ComponentProps<typeof AutomationTimeline>, "deviceNames" | "onRefreshDevices"> & { orgId: string }) {
  const needsNames = timeline.events.some(isDeviceCue);
  const load = useCallback(() => needsNames ? getAutomationDeviceNames({ data: { orgId } }) : Promise.resolve([]), [needsNames, orgId]);
  const { choices, retry } = useCueChoices(load);
  return <AutomationTimeline {...timeline} deviceNames={choices} onRefreshDevices={retry} />;
}
