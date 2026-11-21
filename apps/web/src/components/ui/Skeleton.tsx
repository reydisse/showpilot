/**
 * Lightweight loading skeletons for route transitions.
 * Matches the broadcast-dark aesthetic — no spinners, just shimmering placeholders.
 */

function Pulse({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-white/[0.06] ${className ?? ""}`}
    />
  );
}

/** Full-page skeleton for the org layout (sidebar + content) */
export function PageSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-4">
        <Pulse className="h-8 w-48" />
        <div className="ml-auto flex gap-2">
          <Pulse className="h-8 w-24" />
          <Pulse className="h-8 w-8" />
        </div>
      </div>

      {/* Content area */}
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-3">
        <Pulse className="h-40 lg:col-span-2" />
        <Pulse className="h-40" />
      </div>
      <Pulse className="h-64" />
    </div>
  );
}

/** Compact skeleton for cards / list items */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-board-border bg-board-card/50 p-4"
        >
          <Pulse className="h-10 w-10 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <Pulse className="h-4 w-2/3" />
            <Pulse className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Skeleton for the board / full-screen views */
export function BoardSkeleton() {
  return (
    <div className="min-h-[100dvh] bg-board-bg p-6 space-y-4">
      <div className="flex items-center justify-between">
        <Pulse className="h-10 w-64" />
        <div className="flex gap-2">
          <Pulse className="h-10 w-10" />
          <Pulse className="h-10 w-10" />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Pulse key={i} className="h-32" />
        ))}
      </div>
    </div>
  );
}

/** Skeleton for auth pages (login, setup, etc.) */
export function AuthSkeleton() {
  return (
    <div className="flex items-center justify-center min-h-[100dvh]">
      <div className="w-full max-w-md px-4 space-y-6">
        <div className="flex flex-col items-center gap-2">
          <Pulse className="h-8 w-32" />
          <Pulse className="h-4 w-24" />
        </div>
        <div className="rounded-2xl border border-white/[0.08] p-8 space-y-4">
          <Pulse className="h-6 w-40 mx-auto" />
          <Pulse className="h-11 w-full" />
          <Pulse className="h-11 w-full" />
          <Pulse className="h-11 w-full" />
        </div>
      </div>
    </div>
  );
}

/** Inline spinner for buttons / small areas */
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        className="opacity-20"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** One loading surface follows the Schedule rail and compact roster geometry. */
export function ScheduleSkeleton() {
  const bar = (width: string) => <div className={`h-3 rounded bg-board-border ${width}`} />;
  return <div className="min-h-screen bg-board-bg text-board-text">
    <header className="flex h-[58px] items-center border-b border-board-border px-6"><h1 className="font-semibold">Schedule</h1></header>
    <div aria-busy="true" aria-label="Schedule" className="schedule-skeleton mx-auto grid min-h-[calc(100vh-58px)] max-w-[1700px] border-x border-board-border lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-6 border-b border-board-border bg-board-card p-4 lg:border-r">
        {bar("w-32")}<div className="grid grid-cols-7 gap-3">{Array.from({length:35},(_,i)=><div key={i} className="h-8 rounded bg-board-border" />)}</div>
        {Array.from({length:3},(_,i)=><div key={i} className="space-y-3 border-t border-board-border py-4">{bar("w-40")}{bar("w-24")}</div>)}
      </aside>
      <main className="min-w-0"><div className="space-y-5 border-b border-board-border p-6">{bar("w-48")}{bar("w-64")}{bar("w-40")}</div>
        <div className="border-b border-board-border p-4">{bar("w-56")}</div>
        {Array.from({length:3},(_,i)=><section key={i}><div className="bg-board-card p-4">{bar("w-32")}</div>{Array.from({length:3},(_,j)=><div key={j} className="flex h-12 items-center gap-4 border-t border-board-border px-4"><div className="h-7 w-7 rounded-full bg-board-border" />{bar("w-1/3")}<div className="ml-auto h-3 w-16 rounded bg-board-border" /></div>)}</section>)}
      </main>
    </div>
  </div>;
}
