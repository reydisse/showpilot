import { Link } from "@tanstack/react-router";

// Shared shell for the public legal pages (/terms, /privacy). These pages
// must not require auth and keep the broadcast-dark look of the product.

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-[100dvh] bg-board-bg text-board-text">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <Link to="/" className="text-xl font-bold tracking-tight">
          <span className="text-fire-500">Show</span>Pilot
        </Link>
        <h1 className="mt-8 text-2xl font-semibold font-[family-name:var(--font-display)]">
          {title}
        </h1>
        <p className="mt-1 text-xs text-board-muted">Last updated: {updated}</p>
        <div className="legal-body mt-8 space-y-6 text-sm leading-7 text-board-muted [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-board-text [&_h2]:mt-8 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_a]:text-fire-500 [&_strong]:text-board-text">
          {children}
        </div>
        <div className="mt-12 pt-6 border-t border-board-border text-xs text-board-muted flex flex-wrap gap-4">
          <Link to="/terms">Terms of Service</Link>
          <Link to="/privacy">Privacy Policy</Link>
          <a href="mailto:support@showpilot.tech">support@showpilot.tech</a>
        </div>
      </div>
    </div>
  );
}
