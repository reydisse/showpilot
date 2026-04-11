import type {
  DeviceModule,
  DeviceConnectionStatus,
  ModuleDefinition,
} from "@/lib/device-modules/types";
import { GenericControlPanel } from "./GenericControlPanel";
import { BridgeRequiredBanner } from "./BridgeRequiredBanner";
import { AlertTriangle } from "lucide-react";

interface DeviceControlPanelProps {
  module: DeviceModule | null;
  status: DeviceConnectionStatus;
  feedbacks: Map<string, unknown>;
  definition: ModuleDefinition | undefined;
  device: { name: string; adapterType: string };
}

export function DeviceControlPanel({
  module,
  status,
  feedbacks,
  definition,
  device,
}: DeviceControlPanelProps) {
  // Unknown adapter type
  if (!definition) {
    return (
      <div className="rounded-xl border border-board-border bg-board-card p-8 text-center">
        <AlertTriangle className="w-8 h-8 text-yellow-500/50 mx-auto mb-3" />
        <p className="text-sm text-board-muted">
          Unknown device type: <code className="text-fire-500">{device.adapterType}</code>
        </p>
        <p className="text-xs text-board-muted/60 mt-1">
          No module registered for this adapter type.
        </p>
      </div>
    );
  }

  // Bridge required
  if (status === "bridge-required") {
    return (
      <div className="space-y-4">
        <BridgeRequiredBanner definition={definition} />
        {/* Show controls disabled so operators can preview what's available */}
        <div className="opacity-50 pointer-events-none">
          <GenericControlPanel
            module={null}
            status={status}
            feedbacks={feedbacks}
            definition={definition}
          />
        </div>
      </div>
    );
  }

  // Disconnected state
  if (status === "disconnected" && !module) {
    return (
      <div className="rounded-xl border border-board-border bg-board-card p-8 text-center">
        <p className="text-sm text-board-muted">
          Click <span className="text-fire-500 font-medium">Connect</span> to start controlling {device.name}
        </p>
      </div>
    );
  }

  // Generic control panel (renders from actions/feedbacks)
  return (
    <GenericControlPanel
      module={module}
      status={status}
      feedbacks={feedbacks}
      definition={definition}
    />
  );
}
