import { createFileRoute, Link } from "@tanstack/react-router";
import { LifeBuoy, Mail } from "lucide-react";

export const Route = createFileRoute("/support")({ component: SupportPage });

function SupportPage() {
  return (
    <main className="min-h-[100dvh] bg-board-bg px-5 py-12 text-board-text">
      <div className="mx-auto max-w-2xl">
        <Link to="/" className="text-xl font-bold tracking-tight"><span className="text-fire-500">Show</span>Pilot</Link>
        <section className="mt-8 rounded-2xl border border-board-border bg-board-card p-7 sm:p-9">
          <LifeBuoy className="size-9 text-fire-400" />
          <h1 className="mt-5 font-[family-name:var(--font-display)] text-2xl font-semibold">ShowPilot Support</h1>
          <p className="mt-3 text-sm leading-6 text-board-muted">Get help with your account, live productions, desktop bridge, devices, billing, or data requests.</p>
          <a href="mailto:support@showpilot.tech" className="mt-6 flex items-center gap-3 rounded-xl border border-board-border bg-board-bg/55 p-4 hover:border-fire-500/35"><Mail className="size-5 text-fire-400" /><span><span className="block text-sm font-semibold">support@showpilot.tech</span><span className="mt-0.5 block text-xs text-board-muted">Include your workspace name and the device you are using.</span></span></a>
          <div className="mt-7 border-t border-board-border pt-6 text-sm"><h2 className="font-semibold">Account and privacy</h2><p className="mt-2 leading-6 text-board-muted">You can start permanent account deletion online without contacting support.</p><Link to="/delete-account" className="mt-3 inline-block text-fire-400 hover:text-fire-300">Delete my account</Link></div>
        </section>
        <div className="mt-6 flex gap-4 text-xs text-board-muted"><Link to="/terms">Terms</Link><Link to="/privacy">Privacy</Link></div>
      </div>
    </main>
  );
}
