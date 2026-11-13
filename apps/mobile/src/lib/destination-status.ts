import type { DestinationControlSnapshot } from "@showpilot/shared/destination-control";
export const destinationStatusLabels: Record<DestinationControlSnapshot["destinations"][number]["status"], string> = {
  none: "No provider output",
  enabled: "Provider output enabled",
  disabled: "Provider output disabled",
  missing: "Provider output missing",
  unconfirmed: "Provider output unconfirmed",
  unknown: "Provider status unknown",
};
