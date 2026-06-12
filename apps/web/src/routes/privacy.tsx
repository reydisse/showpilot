/*
 * ─────────────────────────────────────────────────────────────────────────
 *  TEMPLATE — REQUIRES FOUNDER/LEGAL REVIEW BEFORE PUBLIC LAUNCH.
 *  Written conservatively with PIPEDA in mind; no certifications are
 *  claimed (no SOC 2, no "GDPR certified"). Open items for review:
 *  legal entity name, province, retention periods.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal/LegalPage";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="June 11, 2026">
      <p>
        ShowPilot is operated from Canada and handles personal information in
        accordance with the Personal Information Protection and Electronic
        Documents Act (PIPEDA). This policy describes what we collect, why,
        where it lives, and the choices you have.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account information</strong> — name, email address, password (stored as a salted hash), and optional profile photo.</li>
        <li><strong>Organization data</strong> — your organization's name, members and their roles, rundowns, schedules, checklists, and production notes your team creates.</li>
        <li><strong>Crew and volunteer information</strong> — names, optional emails, roles, and check-in/check-out timestamps recorded when crew check in for a show. Church member and crew data is personal information and is treated as such.</li>
        <li><strong>Billing information</strong> — subscription status and plan. Payment card details go directly to Stripe; we never see or store card numbers.</li>
        <li><strong>Usage data</strong> — when analytics is enabled, product usage events (pages used, features clicked) tied to your account, collected via PostHog.</li>
      </ul>

      <h2>Why we collect it</h2>
      <ul>
        <li>To provide the service: running shows, coordinating crews, syncing state between operators.</li>
        <li>To bill subscriptions and prevent abuse.</li>
        <li>To send transactional email (verification, invitations, password resets) and respond to support requests.</li>
        <li>To understand and improve the product (analytics, when enabled).</li>
      </ul>
      <p>We do not sell personal information, and we do not use your data for advertising.</p>

      <h2>Where your data lives</h2>
      <p>
        Application data is stored on Cloudflare's infrastructure (D1 database
        and R2 object storage) and served from Cloudflare's global network. We
        use a small set of subprocessors to run the service:
      </p>
      <ul>
        <li><strong>Cloudflare</strong> — hosting, database, storage, and network.</li>
        <li><strong>Stripe</strong> — payment processing.</li>
        <li><strong>Resend</strong> — transactional email delivery.</li>
        <li><strong>PostHog</strong> — product analytics (only when enabled).</li>
      </ul>

      <h2>Retention and deletion</h2>
      <ul>
        <li>Organization data is retained while the organization exists.</li>
        <li>Deleting an organization permanently removes its data — members, crew records, rundowns, settings, and stored files — from our systems.</li>
        <li>You may request deletion of your personal information at any time by writing to <a href="mailto:support@showpilot.tech">support@showpilot.tech</a>; we respond within a reasonable time as required by PIPEDA.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        Under PIPEDA you may request access to the personal information we
        hold about you, ask that inaccuracies be corrected, withdraw consent,
        and complain to the Office of the Privacy Commissioner of Canada.
        Contact us first and we will do our best to resolve any concern.
      </p>

      <h2>Security</h2>
      <p>
        Access to organization data is scoped per organization and protected
        by role-based permissions. Passwords are hashed, transport is
        encrypted (HTTPS), and secrets are managed in our hosting provider's
        secret store. No internet service can guarantee absolute security; we
        notify affected users of breaches as required by law.
      </p>

      <h2>Children</h2>
      <p>
        ShowPilot is a tool for production teams and is not directed at
        children. Crew check-in records for minors (e.g. student volunteers)
        are created and managed by your organization, which is responsible
        for obtaining any consent it requires.
      </p>

      <h2>Changes</h2>
      <p>
        We will post updates to this policy here and announce material changes
        in the app or by email.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions or requests:{" "}
        <a href="mailto:support@showpilot.tech">support@showpilot.tech</a>.
      </p>
    </LegalPage>
  );
}
