import { AlertTriangle, Download } from "lucide-react";
import type { ModuleDefinition } from "@/lib/device-modules/types";

interface BridgeRequiredBannerProps {
  definition: ModuleDefinition;
}

export function BridgeRequiredBanner({ definition }: BridgeRequiredBannerProps) {
  return (
    <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-6">
      <div className="flex items-start gap-4">
        <div className="rounded-lg bg-yellow-500/10 p-2.5">
          <AlertTriangle className="w-5 h-5 text-yellow-500" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-board-text mb-1">
            Bridge Agent Required
          </h3>
          <p className="text-sm text-board-muted leading-relaxed">
            {definition.displayName} uses {definition.transport.toUpperCase()} protocol which cannot
            be accessed directly from a browser. A ShowPilot Bridge agent running
            on your local network is required to control this device.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <button
              disabled
              className="inline-flex items-center gap-2 rounded-lg bg-board-card border border-board-border px-3 py-1.5 text-xs font-medium text-board-muted opacity-50 cursor-not-allowed"
            >
              <Download className="w-3 h-3" />
              Download Bridge
            </button>
            <span className="text-[10px] text-board-muted/60 uppercase tracking-wider">
              Coming Soon
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
