import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle } from "lucide-react";

// Public confirmation page; organization deletion keeps the account available.
export const Route = createFileRoute("/org-deleted")({
  component: OrgDeletedPage,
});

function OrgDeletedPage() {
  return (
    <div className="min-h-[100dvh] bg-board-bg flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-board-border bg-board-card p-8 text-center">
        <CheckCircle className="w-10 h-10 text-green-400 mx-auto mb-4" />
        <h1 className="text-lg font-semibold text-board-text mb-2 font-[family-name:var(--font-display)]">
          Organization deleted
        </h1>
        <p className="text-sm text-board-muted mb-6">
          The organization and all of its data have been permanently removed.
          Any active subscription was cancelled. Your account and other organizations are kept.
        </p>
        <Link
          to="/"
          className="inline-block px-4 py-2.5 rounded-xl bg-fire-500 text-white text-sm font-medium hover:bg-fire-600 transition-colors"
        >
          Continue to ShowPilot
        </Link>
      </div>
    </div>
  );
}
