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
  const bar = (width: string, height = "h-2.5") => <span className={`block ${height} rounded bg-[#222226] ${width}`} />;
  const card = "rounded-xl border border-[#242428] bg-[#131315]";
  return <div className="h-full bg-board-bg text-board-text">
    <p role="status" aria-live="polite" className="sr-only">Loading schedule…</p>
    <div aria-hidden="true" className="schedule-skeleton mx-auto grid min-h-[calc(100vh-58px)] max-w-[1700px] border-x border-board-border lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="hidden flex-col gap-4 border-r border-board-border px-3 pb-4 pt-5 lg:flex">
        <div className="flex items-center justify-between pl-2 pr-1.5"><h2 className="text-xl font-semibold tracking-[-0.015em]">Schedule</h2>{bar("w-24", "h-7")}</div>
        <div className={`${card} flex flex-col gap-3 p-3`}>{bar("w-28", "h-3")}<div className="grid grid-cols-7 gap-1.5">{Array.from({ length: 35 }, (_, i) => <span key={i} className="h-[26px] rounded-md bg-[#1a1a1d]" />)}</div></div>
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="flex items-center gap-3 px-2.5 py-2"><span className="h-8 w-8 rounded-md bg-[#1a1a1d]" /><div className="flex flex-col gap-1.5">{bar("w-36")}{bar("w-24")}</div></div>)}
      </aside>
      <main className="flex min-w-0 flex-col gap-5 px-4 pb-10 pt-6 md:px-6 lg:px-8">
        <div className="flex flex-col gap-3">{bar("w-40")}{bar("w-64", "h-6")}<div className="flex gap-4">{bar("w-16")}{bar("w-24")}{bar("w-28")}</div></div>
        <div className={`${card} flex flex-col gap-4 p-4`}>{bar("w-44", "h-3.5")}<span className="block h-1.5 rounded bg-[#222226]" /><div className="flex gap-2">{["w-12", "w-24", "w-24", "w-16"].map((w, i) => <span key={i} className={`block h-6 rounded-md bg-[#222226] ${w}`} />)}</div></div>
        {Array.from({ length: 2 }, (_, g) => <section key={g} className={`${card} overflow-hidden`}><div className="flex h-11 items-center px-3">{bar("w-36")}</div>{Array.from({ length: 4 }, (_, r) => <div key={r} className="flex h-12 items-center gap-4 px-4 shadow-[inset_0_1px_0_#242428]"><span className="h-7 w-7 shrink-0 rounded-full bg-[#222226]" />{bar("w-1/4")}<span className="flex-1" />{bar("w-20")}{bar("w-10")}{bar("w-20")}</div>)}</section>)}
      </main>
    </div>
  </div>;
}
