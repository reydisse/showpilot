import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";

export const Route = createFileRoute("/account-deleted")({ component: AccountDeletedPage });

function AccountDeletedPage() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-board-bg p-6 text-board-text">
      <section className="w-full max-w-md rounded-2xl border border-board-border bg-board-card p-8 text-center">
        <CheckCircle2 className="mx-auto size-10 text-green-400" />
        <h1 className="mt-4 font-[family-name:var(--font-display)] text-xl font-semibold">Account deleted</h1>
        <p className="mt-2 text-sm leading-6 text-board-muted">Your ShowPilot account and account-linked personal data have been permanently removed. You have been signed out on every device.</p>
        <Link to="/" className="mt-6 inline-block rounded-xl bg-fire-500 px-4 py-2.5 text-sm font-semibold text-black">Return to ShowPilot</Link>
      </section>
    </main>
  );
}
