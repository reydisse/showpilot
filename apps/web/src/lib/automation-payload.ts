import type { AutomationEvent } from "@/types/timecode";
import { proPresenterPayloadProblem } from "./automation-propresenter";

const isId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;

export function automationPayloadProblem(event: Pick<AutomationEvent, "action" | "payload" | "targetDeviceId">): string | null {
  if (event.action === "rundown-goto-item" && !isId(event.payload.itemId)) {
    return "Choose a rundown item for this jump.";
  }
  if (event.action === "lighting-blackout" && [event.targetDeviceId, event.payload.deviceId, event.payload.targetDeviceId].some(value => value !== undefined && !isId(value))) {
    return "Choose a valid lighting device for blackout.";
  }
  return proPresenterPayloadProblem(event.action, event.payload);
}
