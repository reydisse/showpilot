import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Wifi, WifiOff, AlertTriangle, Loader2 } from "lucide-react";
import { getDevice } from "@/lib/data";
import { useDeviceModule } from "@/hooks/useDeviceModule";
import { DeviceControlPanel } from "@/components/devices/DeviceControlPanel";

export const Route = createFileRoute("/$slug/dashboard/devices/$deviceId")({
  loader: async ({ params }) => {
    const device = await getDevice({ data: { id: params.deviceId } });
    if (!device) throw new Error("Device not found");
    return { device };
  },
  component: DeviceDetailPage,
});

function DeviceDetailPage() {
  const { device } = Route.useLoaderData();
  const { slug } = Route.useParams();
  const { module, status, feedbacks, definition, connect, disconnect } =
    useDeviceModule(device);

  return (
    <div className="min-h-screen bg-board-bg p-4 md:p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to={`/${slug}/dashboard/devices`}
            className="rounded-lg border border-board-border bg-board-card p-2 text-board-muted hover:text-board-text transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-semibold text-board-text">
              {device.name}
            </h1>
            <p className="text-xs text-board-muted">
              {definition?.displayName ?? device.adapterType}
            </p>
          </div>
        </div>

        {/* Connection controls */}
        <div className="flex items-center gap-3">
          <ConnectionBadge status={status} />
          {status === "connected" ? (
            <button
              onClick={disconnect}
              className="rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-muted hover:text-red-400 hover:border-red-500/20 transition-colors"
            >
              Disconnect
            </button>
          ) : status === "disconnected" || status === "error" ? (
            <button
              onClick={connect}
              className="rounded-lg bg-fire-500/10 border border-fire-500/20 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
            >
              Connect
            </button>
          ) : null}
        </div>
      </div>

      {/* Control Panel */}
      <DeviceControlPanel
        module={module}
        status={status}
        feedbacks={feedbacks}
        definition={definition}
        device={device}
      />
    </div>
  );
}

function ConnectionBadge({ status }: { status: string }) {
  const configs: Record<
    string,
    { dot: string; label: string; icon: React.ElementType }
  > = {
    connected: { dot: "bg-green-500", label: "Connected", icon: Wifi },
    connecting: { dot: "bg-yellow-500 animate-pulse", label: "Connecting...", icon: Loader2 },
    disconnected: { dot: "bg-board-muted/30", label: "Disconnected", icon: WifiOff },
    error: { dot: "bg-red-500", label: "Error", icon: AlertTriangle },
    "bridge-required": { dot: "bg-yellow-500", label: "Bridge Required", icon: AlertTriangle },
  };

  const cfg = configs[status] ?? configs.disconnected;
  const Icon = cfg.icon;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-board-border bg-board-card px-3 py-1.5">
      <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      <Icon className="w-3 h-3 text-board-muted" />
      <span className="text-xs font-medium text-board-muted">{cfg.label}</span>
    </div>
  );
}
