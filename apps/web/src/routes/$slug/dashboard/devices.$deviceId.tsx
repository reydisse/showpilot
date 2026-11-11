import { PageBreadcrumb } from "@/components/ui/PageBreadcrumb";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeft, Wifi, WifiOff, AlertTriangle, Loader2 } from "lucide-react";
import { getDevice } from "@/lib/data";
import { useDeviceModule } from "@/hooks/useDeviceModule";
import { DeviceControlPanel } from "@/components/devices/DeviceControlPanel";

export const Route = createFileRoute("/$slug/dashboard/devices/$deviceId")({
  loader: async ({ context, params, abortController }) => {
    const device = await getDevice({ data: { orgId: context.orgId, id: params.deviceId }, signal: abortController.signal });
    if (!device) throw notFound();
    return { device };
  },
  component: DeviceDetailRoute,
  notFoundComponent: DeviceNotFound,
});

function DeviceDetailRoute() {
  const { device } = Route.useLoaderData();
  return <DeviceDetailPage key={device.id} device={device} />;
}

function DeviceDetailPage({ device }: { device: NonNullable<Awaited<ReturnType<typeof getDevice>>> }) {
  const { slug } = Route.useParams();
  const { orgId } = Route.useRouteContext();
  const { module, status, feedbacks, definition, error, errorAt, connect, disconnect } =
    useDeviceModule(device, orgId);

  return (
    <div className="h-full min-h-0 overflow-auto bg-board-bg p-4 md:p-6">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <PageBreadcrumb current="Device details">
            <Link activeOptions={{ exact: true }}
              to="/$slug/dashboard/devices"
              params={{ slug }}
              search={{ device: device.id }}
              aria-label="Back to devices"
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-board-border bg-board-card px-3 py-2 text-board-muted outline-none transition-colors hover:text-board-text focus-visible:ring-2 focus-visible:ring-fire-500"
            >
              <ArrowLeft className="w-4 h-4" />
              Devices
            </Link>
          </PageBreadcrumb>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-board-text truncate">
              {device.name}
            </h1>
            <p className="text-xs text-board-muted truncate">
              {definition?.displayName ?? device.adapterType}
            </p>
          </div>
        </div>

        {/* Connection controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          <ConnectionBadge status={status} />
          {status === "connected" ? (
            <button
              onClick={disconnect}
              className="min-h-[44px] rounded-lg border border-board-border bg-board-card px-3 py-1.5 text-xs font-medium text-board-muted hover:text-red-400 hover:border-red-500/20 transition-colors"
            >
              Disconnect
            </button>
          ) : status === "disconnected" || status === "error" ? (
            <button
              onClick={connect}
              disabled={!module}
              className="min-h-[44px] rounded-lg bg-fire-500/10 border border-fire-500/20 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
            >
              {error ? "Retry connection" : "Connect"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p role="alert" className="mb-4 rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">{error} {errorAt !== null && <time dateTime={new Date(errorAt).toISOString()}>{new Date(errorAt).toLocaleTimeString()}</time>}</p> : null}

      {/* Control Panel */}
      <DeviceControlPanel
        key={device.id}
        module={module}
        status={status}
        feedbacks={feedbacks}
        definition={definition}
        device={device}
      />
    </div>
  );
}

function DeviceNotFound() {
  const { slug } = Route.useParams();
  return <section className="space-y-4 p-4 md:p-6">
    <h1 className="text-lg font-semibold text-board-text">Device unavailable</h1>
    <p className="text-sm text-board-muted">This device may have been removed, or the link is incorrect.</p>
    <Link to="/$slug/dashboard/devices" params={{ slug }} className="inline-flex min-h-11 items-center rounded-lg border border-board-border px-4 text-sm text-board-text outline-none focus-visible:ring-2 focus-visible:ring-fire-500">Back to devices</Link>
  </section>;
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
