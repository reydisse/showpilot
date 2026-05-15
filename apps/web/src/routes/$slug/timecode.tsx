import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { FileDown } from "lucide-react";
import { useTimecode } from "@/hooks/useTimecode";
import { TimecodeDisplay } from "@/components/timecode/TimecodeDisplay";
import { TimecodeSourceSelector } from "@/components/timecode/TimecodeSourceSelector";
import { AutomationTimeline } from "@/components/timecode/AutomationTimeline";
import { AutomationEventEditor } from "@/components/timecode/AutomationEventEditor";
import { DEMO_EVENTS } from "@/lib/seed-timecode-demo";

export const Route = createFileRoute("/$slug/timecode")({
  beforeLoad: async ({ context, params }) => {
    const { withPermission } = await import("@/lib/route-permissions");
    await withPermission(context.role, "timecode:access", params.slug, context.orgId);
  },
  component: TimecodePage,
});

function TimecodePage() {
  const { orgId } = Route.useRouteContext() as { orgId: string };

  const {
    state,
    display,
    connected,
    events,
    isMaster,
    startFreerun,
    stopGenerator,
    startMtc,
    stopMtc,
    setTimecode,
    setFormat,
    addEvent,
    updateEvent,
    removeEvent,
    resetEvents,
    mtcSupported,
  } = useTimecode({ orgId, enabled: true });

  const [demoLoaded, setDemoLoaded] = useState(false);

  function loadDemo() {
    for (const event of DEMO_EVENTS) {
      addEvent(event);
    }
    setDemoLoaded(true);
  }

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
              SMPTE Timecode
            </h1>
            <p className="text-xs text-board-muted mt-0.5">
              Show automation sequencer
            </p>
          </div>
          <div className="flex items-center gap-3">
            {events.length === 0 && !demoLoaded && (
              <button
                onClick={loadDemo}
                className="flex items-center gap-1.5 rounded-lg border border-fire-500/20 bg-fire-500/10 px-3 py-1.5 text-xs font-medium text-fire-500 hover:bg-fire-500/20 transition-colors"
              >
                <FileDown className="w-3 h-3" />
                Load Demo Show
              </button>
            )}
            <TimecodeDisplay state={state} connected={connected} size="compact" />
          </div>
        </div>
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Large TC display */}
        <div className="rounded-xl border border-board-border bg-board-card p-8">
          <TimecodeDisplay state={state} connected={connected} size="large" />
        </div>

        {/* Source selector */}
        <TimecodeSourceSelector
          isMaster={isMaster}
          running={state?.running ?? false}
          format={state?.format ?? { frameRate: 30, dropFrame: "ndf" }}
          mtcSupported={mtcSupported}
          onStartFreerun={startFreerun}
          onStopGenerator={stopGenerator}
          onStartMtc={startMtc}
          onSetFormat={setFormat}
        />

        {/* Automation timeline */}
        <AutomationTimeline
          events={events}
          state={state}
          onRemoveEvent={removeEvent}
          onResetEvents={resetEvents}
        />

        {/* Add event */}
        <AutomationEventEditor onAdd={addEvent} />
      </div>
    </div>
  );
}
