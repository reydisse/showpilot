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
