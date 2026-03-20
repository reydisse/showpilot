import { useState } from "react";
import {
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  Plug,
  Unplug,
  FlaskConical,
} from "lucide-react";

type ConnectionStatus = "connected" | "disconnected" | "error";

interface IntegrationCardProps {
  name: string;
  icon: React.ReactNode;
  description: string;
  connected: boolean;
  status?: ConnectionStatus;
  onConnect: () => void | Promise<void>;
  onDisconnect: () => void | Promise<void>;
  onTest?: () => Promise<{ ok: boolean; error?: string } | void>;
  disabled?: boolean;
  comingSoon?: boolean;
  children?: React.ReactNode;
}

const STATUS_CONFIG: Record<
  ConnectionStatus,
  { label: string; icon: React.ElementType; color: string }
> = {
  connected: {
    label: "Connected",
    icon: CheckCircle,
    color: "text-green-400 bg-green-500/10 border-green-500/20",
  },
  disconnected: {
    label: "Disconnected",
    icon: XCircle,
    color: "text-board-muted bg-board-bg border-board-border",
  },
  error: {
    label: "Error",
    icon: AlertCircle,
    color: "text-red-400 bg-red-500/10 border-red-500/20",
  },
};

export function IntegrationCard({
  name,
  icon,
  description,
  connected,
  status = connected ? "connected" : "disconnected",
  onConnect,
  onDisconnect,
  onTest,
  disabled = false,
  comingSoon = false,
  children,
}: IntegrationCardProps) {
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const statusConfig = STATUS_CONFIG[status];
  const StatusIcon = statusConfig.icon;

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await onConnect();
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setConnecting(true);
    try {
      await onDisconnect();
    } finally {
      setConnecting(false);
    }
  };

  const handleTest = async () => {
    if (!onTest) return;
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const result = await onTest();
      if (result && typeof result === "object" && "ok" in result) {
        setTestResult(result.ok ? "success" : "error");
        if (!result.ok && result.error) setTestError(result.error);
      } else {
        setTestResult("success");
      }
    } catch (err) {
      setTestResult("error");
      setTestError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setTesting(false);
      setTimeout(() => { setTestResult(null); setTestError(null); }, 5000);
    }
  };

  return (
    <div
      className={`rounded-xl border p-4 transition-all ${
        connected
          ? "bg-board-card border-green-500/20"
          : "bg-board-card border-board-border"
      } ${comingSoon ? "opacity-60" : ""}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-board-bg border border-board-border flex items-center justify-center shrink-0 text-board-muted">
          {icon}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-semibold text-board-text">{name}</h3>
            {comingSoon && (
              <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded bg-fire-500/15 text-fire-500 border border-fire-500/25">
                Coming Soon
              </span>
            )}
          </div>
          <p className="text-xs text-board-muted mb-3">{description}</p>

          {/* Connection status badge */}
          <div className="flex items-center gap-2 mb-3">
            <span
              className={`inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded border ${statusConfig.color}`}
            >
              <StatusIcon className="w-3 h-3" />
              {statusConfig.label}
            </span>
          </div>

          {/* Test error message */}
          {testError && (
            <div className="mb-2 px-2.5 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-[11px] text-red-300 break-all">{testError}</p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {!connected ? (
              <button
                onClick={handleConnect}
                disabled={disabled || comingSoon || connecting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {connecting ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Plug className="w-3 h-3" />
                )}
                Connect
              </button>
            ) : (
              <>
                <button
                  onClick={handleDisconnect}
                  disabled={connecting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/20 text-red-400 text-xs font-medium hover:bg-red-500/30 transition-colors disabled:opacity-50"
                >
                  {connecting ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Unplug className="w-3 h-3" />
                  )}
                  Disconnect
                </button>
                {onTest && (
                  <button
                    onClick={handleTest}
                    disabled={testing}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors disabled:opacity-50 ${
                      testResult === "success"
                        ? "border-green-500/30 text-green-400 bg-green-500/10"
                        : testResult === "error"
                          ? "border-red-500/30 text-red-400 bg-red-500/10"
                          : "border-board-border text-board-muted hover:text-board-text hover:bg-board-border/50"
                    }`}
                  >
                    {testing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : testResult === "success" ? (
                      <CheckCircle className="w-3 h-3" />
                    ) : testResult === "error" ? (
                      <XCircle className="w-3 h-3" />
                    ) : (
                      <FlaskConical className="w-3 h-3" />
                    )}
                    {testResult === "success" ? "Connected" : testResult === "error" ? "Failed" : "Test"}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Children slot for integration-specific settings */}
      {connected && children && (
        <div className="mt-4 pt-4 border-t border-board-border/50 pl-[52px]">
          {children}
        </div>
      )}
    </div>
  );
}
