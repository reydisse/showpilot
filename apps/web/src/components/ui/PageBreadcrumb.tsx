import type { ReactNode } from "react";

/** The parent is a real route Link so it works after direct entry as well as SPA navigation. */
export function PageBreadcrumb({
  children,
  current,
}: {
  children: ReactNode;
  current: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-board-muted"
    >
      {children}
      <span aria-hidden="true">/</span>
      <span aria-current="page" className="min-w-0 break-words">
        {current}
      </span>
    </nav>
  );
}
