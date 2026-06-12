/*
 * ─────────────────────────────────────────────────────────────────────────
 *  TEMPLATE — REQUIRES FOUNDER/LEGAL REVIEW BEFORE PUBLIC LAUNCH.
 *  Written conservatively; no certifications or guarantees are claimed.
 *  Open items for review: governing province, refund policy specifics.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal/LegalPage";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="June 11, 2026">
      <p>
        These Terms of Service ("Terms") govern your use of ShowPilot, a live
        production management platform operated from Canada ("ShowPilot",
        "we", "us"). By creating an account or using showpilot.tech you agree
        to these Terms.
      </p>

      <h2>1. The service</h2>
      <p>
        ShowPilot provides tools for planning and running live productions —
        rundowns, timers, crew management, communications, and device
        integrations. The service is provided on a subscription basis per
        organization. We may add, change, or remove features over time.
      </p>

      <h2>2. Accounts and organizations</h2>
      <ul>
        <li>You must provide accurate information and keep your credentials secure. You are responsible for activity under your account.</li>
        <li>An organization's owner controls its membership, data, and subscription, including the ability to permanently delete the organization.</li>
        <li>You must be legally able to enter this agreement and, where acting for an organization, authorized to bind it.</li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>
        You agree not to misuse the service: no unlawful content or activity,
        no attempts to breach security or access other organizations' data, no
        reselling of the service, and no interference with other customers'
        use. We may suspend accounts that put the platform or other customers
        at risk.
      </p>

      <h2>4. Subscriptions and billing</h2>
      <ul>
        <li>Paid plans are billed per organization through our payment processor, Stripe. We do not store card numbers.</li>
        <li>Trials convert to a paid plan only when you subscribe; we do not charge without a subscription.</li>
        <li>Plans renew automatically until cancelled. Cancellation takes effect at the end of the current billing period.</li>
        <li>Prices may change with reasonable advance notice; founding-member pricing remains in effect while that subscription stays active.</li>
      </ul>

      <h2>5. Your data</h2>
      <p>
        Your organization's data belongs to you. You can export show data from
        the app and request deletion at any time; deleting an organization
        permanently removes its data from our systems. Our handling of
        personal information is described in the{" "}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>6. Availability and support</h2>
      <p>
        We work to keep ShowPilot reliable for live production use, but the
        service is provided <strong>"as is" and "as available"</strong>{" "}
        without warranties of any kind, whether express or implied. We do not
        guarantee uninterrupted or error-free operation. Support is available
        at <a href="mailto:support@showpilot.tech">support@showpilot.tech</a>.
      </p>

      <h2>7. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, ShowPilot is not liable for
        indirect, incidental, special, or consequential damages, or for lost
        profits, revenues, or data, arising from your use of the service. Our
        total liability for any claim is limited to the amounts you paid us in
        the twelve months before the claim arose. Nothing in these Terms
        limits liability that cannot be limited under applicable law.
      </p>

      <h2>8. Termination</h2>
      <p>
        You may stop using the service and cancel at any time. We may suspend
        or terminate accounts for material breach of these Terms after
        reasonable notice where practicable. On termination you retain the
        right to request a copy of your data for a reasonable period.
      </p>

      <h2>9. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. Material changes will be
        announced in the app or by email before they take effect. Continued
        use after the effective date constitutes acceptance.
      </p>

      <h2>10. Governing law</h2>
      <p>
        These Terms are governed by the laws of Canada and the province in
        which ShowPilot is established, without regard to conflict-of-law
        rules.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these Terms:{" "}
        <a href="mailto:support@showpilot.tech">support@showpilot.tech</a>.
      </p>
    </LegalPage>
  );
}
