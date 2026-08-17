import { env } from "cloudflare:workers";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailOptions) {
  const apiKey: string | undefined = env.RESEND_API_KEY;

  console.log("[email] sendEmail called:", { to, subject, hasApiKey: !!apiKey });

  if (!apiKey) {
    console.error("[email] RESEND_API_KEY not set");
    throw new Error("Email service not configured");
  }

  const from = "ShowPilot <noreply@showpilot.tech>";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  const body = await res.text();
  console.log("[email] Resend response:", res.status, body);

  if (!res.ok) {
    throw new Error(`Email send failed: ${res.status} — ${body}`);
  }
}

// ─── Shared wrapper ─────────────────────────────────────────
// Dark background baked into every email so it renders correctly
// in all clients (Gmail, Outlook, Apple Mail). Every email carries the
// same footer: company line + support address; `unsubscribeNote` is added
// on non-transactional sends (e.g. waitlist) where opt-out applies.

function emailWrapper(content: string, opts: { unsubscribeNote?: string } = {}) {
  return `
    <div style="background-color:#0a0a0a;margin:0;padding:0;width:100%;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">ShowPilot production operations</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#0a0a0a;border-collapse:collapse;">
        <tr><td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border-collapse:separate;background-color:#141414;border:1px solid #2a2a2a;border-radius:16px;overflow:hidden;">
            <tr><td style="height:4px;background-color:#ffc107;font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr><td style="padding:28px 32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              <div style="color:#f5f5f5;font-size:25px;font-weight:800;letter-spacing:-0.7px;line-height:1;">
                <span style="color:#ffc107;">Show</span>Pilot
              </div>
              <div style="color:#888888;font-size:11px;font-weight:600;letter-spacing:1.4px;margin-top:8px;text-transform:uppercase;">Live production operations</div>
            </td></tr>
            <tr><td style="padding:4px 32px 32px;color:#e5e5e5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              ${content}
            </td></tr>
            <tr><td style="border-top:1px solid #2a2a2a;padding:22px 32px 26px;color:#777777;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
              <p style="font-size:12px;line-height:1.5;margin:0 0 5px;">ShowPilot — run your show, not your software.</p>
              <p style="font-size:12px;line-height:1.5;margin:0;">Questions? <a href="mailto:support@showpilot.tech" style="color:#ffc107;text-decoration:none;">support@showpilot.tech</a></p>
              ${opts.unsubscribeNote ? `<p style="color:#666666;font-size:11px;line-height:1.5;margin:14px 0 0;">${opts.unsubscribeNote}</p>` : ""}
            </td></tr>
          </table>
        </td></tr>
      </table>
    </div>
  `;
}

export function crewScheduleEmail(input: {
  orgName: string;
  serviceName: string;
  serviceDate: string;
  start: string;
  role: string;
  link: string;
  reminder?: boolean;
}) {
  const escape = (value: string) =>
    value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
  return {
    subject: `${input.reminder ? "Response needed" : "You're scheduled"}: ${input.serviceName}`,
    html: emailWrapper(`
      <p style="color:#ffc107;font-size:12px;font-weight:700;letter-spacing:1.2px;margin:0 0 12px;text-transform:uppercase;">${escape(input.orgName)}</p>
      <h1 style="color:#f5f5f5;font-size:27px;line-height:1.2;letter-spacing:-0.5px;margin:0 0 12px;">${input.reminder ? "Can you serve?" : "You've been scheduled"}</h1>
      <p style="color:#a3a3a3;font-size:14px;line-height:1.6;margin:0 0 24px;">Review this assignment and let your production team know if you're available.</p>
      <div style="background-color:#0a0a0a;border:1px solid #2a2a2a;border-left:3px solid #ffc107;border-radius:10px;margin:0 0 24px;padding:18px 20px;">
        <p style="color:#f5f5f5;font-size:16px;font-weight:700;line-height:1.4;margin:0 0 9px;">${escape(input.serviceName)}</p>
        <p style="color:#a3a3a3;font-size:14px;line-height:1.7;margin:0;">${escape(input.serviceDate)} · ${escape(input.start)}<br><span style="color:#e5e5e5;">${escape(input.role)}</span></p>
      </div>
      <a href="${escape(input.link)}" style="background-color:#ffc107;border-radius:9px;color:#0a0a0a;display:inline-block;font-size:14px;font-weight:700;padding:13px 22px;text-decoration:none;">Accept or decline</a>
      <p style="color:#777777;font-size:12px;line-height:1.6;margin:24px 0 0;">No account is needed. This secure link is unique to you and expires in 90 days.</p>
    `),
  };
}

// ─── Email Templates ────────────────────────────────────────

export function passwordResetEmail(resetUrl: string) {
  return {
    subject: "Reset your ShowPilot password",
    html: emailWrapper(`
      <p style="color: #888; font-size: 14px; margin: 0 0 32px 0;">Password Reset</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
        Someone requested a password reset for your account. Click the button below to set a new password.
      </p>
      <a href="${resetUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background: #FFC107; color: #000; font-weight: 600; text-decoration: none; border-radius: 8px; font-size: 15px;">
        Reset Password
      </a>
      <p style="color: #888; font-size: 13px; line-height: 1.5; margin: 0;">
        If you didn't request this, you can safely ignore this email. The link expires in 1 hour.
      </p>
    `),
  };
}

export function verificationEmail(verifyUrl: string) {
  return {
    subject: "Verify your ShowPilot email",
    html: emailWrapper(`
      <p style="color: #888; font-size: 14px; margin: 0 0 32px 0;">Email Verification</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
        Welcome to ShowPilot! Confirm your email address to finish setting up your account and create your organization.
      </p>
      <a href="${verifyUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background: #FFC107; color: #000; font-weight: 600; text-decoration: none; border-radius: 8px; font-size: 15px;">
        Verify Email
      </a>
      <p style="color: #888; font-size: 13px; line-height: 1.5; margin: 0;">
        If you didn't create a ShowPilot account, you can safely ignore this email.
      </p>
    `),
  };
}

export function waitlistConfirmationEmail(name?: string) {
  const greeting = name ? `Hi ${name},` : "Hi there,";
  return {
    subject: "You're on the ShowPilot waitlist!",
    html: emailWrapper(`
      <p style="color: #888; font-size: 14px; margin: 0 0 32px 0;">Waitlist Confirmation</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">${greeting}</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
        Thanks for signing up for ShowPilot! We're building the operating system for live production — rundowns, timers, device control, lower thirds, and production chat, all in one platform.
      </p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
        We're onboarding teams in waves. When it's your turn, we'll send you a link to create your account and set up your organization.
      </p>
      <div style="margin: 32px 0; padding: 20px; border-radius: 12px; border: 1px solid #2a2a2a; background-color: #141414;">
        <p style="color: #FFC107; font-size: 13px; font-weight: 600; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.05em;">What's coming</p>
        <ul style="color: #e5e5e5; font-size: 14px; line-height: 1.8; padding-left: 18px; margin: 0;">
          <li>Drag-and-drop rundowns with live timers</li>
          <li>Control your audio console, video switcher &amp; lights</li>
          <li>Push lower thirds to OBS and vMix</li>
          <li>Production chat with your team</li>
          <li>Connect ProPresenter, OnTime, Slack, and more</li>
        </ul>
      </div>
      <p style="color: #888; font-size: 13px; line-height: 1.5; margin: 0;">Sit tight — we'll be in touch soon.</p>
    `, {
      unsubscribeNote:
        "You're receiving this because you joined the ShowPilot waitlist. Reply to this email or write to support@showpilot.tech to be removed.",
    }),
  };
}

export function waitlistInviteEmail(name: string | undefined, signupUrl: string) {
  const greeting = name ? `Hi ${name},` : "Hi there,";
  return {
    subject: "Your ShowPilot access is ready!",
    html: emailWrapper(`
      <p style="color: #888; font-size: 14px; margin: 0 0 32px 0;">You're In!</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">${greeting}</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
        Great news — your early access to ShowPilot is ready. Click below to create your account and set up your production team.
      </p>
      <a href="${signupUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background: #FFC107; color: #000; font-weight: 600; text-decoration: none; border-radius: 8px; font-size: 15px;">
        Get Started
      </a>
      <p style="color: #888; font-size: 13px; line-height: 1.5; margin: 0;">
        Once you're in, you can invite your team, connect your devices, and build your first runsheet.
      </p>
    `, {
      unsubscribeNote:
        "You're receiving this because you joined the ShowPilot waitlist. Reply to this email or write to support@showpilot.tech to be removed.",
    }),
  };
}

export function invitationEmail(orgName: string, inviterName: string, inviteUrl: string) {
  return {
    subject: `You're invited to join ${orgName} on ShowPilot`,
    html: emailWrapper(`
      <p style="color: #888; font-size: 14px; margin: 0 0 32px 0;">Team Invitation</p>
      <p style="color: #e5e5e5; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
        <strong style="color: #f5f5f5;">${inviterName}</strong> has invited you to join <strong style="color: #f5f5f5;">${orgName}</strong> on ShowPilot.
      </p>
      <a href="${inviteUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background: #FFC107; color: #000; font-weight: 600; text-decoration: none; border-radius: 8px; font-size: 15px;">
        Accept Invitation
      </a>
      <p style="color: #888; font-size: 13px; line-height: 1.5; margin: 0;">
        If you don't have a ShowPilot account, you'll be asked to create one first.
      </p>
    `),
  };
}
