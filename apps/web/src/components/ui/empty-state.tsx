import type { ComponentType, ReactNode } from "react";

interface EmptyStateProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  /** Primary action — a button or link rendered under the description. */
  action?: ReactNode;
  className?: string;
}

/**
 * Shared empty state for lists/dashboards that can render with no data.
 * Always pairs an explanation with a primary action so operators are never
 * left staring at a blank screen.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center px-6 py-16 rounded-xl border border-dashed border-board-border ${className ?? ""}`}
    >
      <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-board-card border border-board-border mb-4">
        <Icon className="w-6 h-6 text-board-muted" />
      </div>
      <h3 className="text-board-text font-medium mb-1">{title}</h3>
      <p className="text-board-muted text-sm max-w-sm mb-4">{description}</p>
      {action}
    </div>
  );
}

/** Default primary-action button styling for EmptyState actions. */
export function EmptyStateButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded-lg text-sm font-medium bg-fire-500 text-white hover:bg-fire-600 transition-colors"
    >
      {children}
    </button>
  );
}
