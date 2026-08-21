import { AlertTriangle, Cable } from "lucide-react";
import type { ModuleDefinition } from "@/lib/device-modules/types";
import { isDesktopRuntime } from "@/lib/desktop-runtime";

interface BridgeRequiredBannerProps {
  definition: ModuleDefinition;
}

export function BridgeRequiredBanner({ definition }: BridgeRequiredBannerProps) {
  const desktop = isDesktopRuntime();
  return (
    <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-yellow-500/10 p-2.5">
          <AlertTriangle className="w-5 h-5 text-yellow-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-board-text mb-1">
            {desktop ? "Local device engine is offline" : "Venue Bridge is offline"}
          </h3>
          <p className="text-sm text-board-muted leading-relaxed">
            {desktop
              ? `${definition.displayName} uses ${definition.transport.toUpperCase()} on this network. ShowPilot Desktop includes the local engine; add the organization Bridge API key in Settings so it can connect.`
              : `${definition.displayName} uses ${definition.transport.toUpperCase()} on the venue network. Keep ShowPilot Bridge running on a computer connected to that network to control it remotely from the web.`}
          </p>
          <div className="mt-4 flex items-center gap-2 text-[11px] text-board-muted">
            <Cable className="h-3.5 w-3.5" />
            {desktop ? "The desktop app supervises this connection automatically." : "The Bridge must run at the venue, not on the remote operator’s computer."}
          </div>
        </div>
      </div>
    </div>
  );
}
