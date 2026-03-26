import { env } from "cloudflare:workers";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailOptions) {
  const apiKey = (env as Record<string, unknown>).RESEND_API_KEY as
    | string
    | undefined;

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
// in all clients (Gmail, Outlook, Apple Mail).

function emailWrapper(content: string) {
  return `
    <div style="background-color: #0a0a0a; padding: 0; margin: 0;">
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background-color: #0a0a0a; color: #e5e5e5;">
        <h2 style="color: #f5f5f5; font-size: 24px; margin: 0 0 8px 0;">
          <span style="color: #FFC107;">Show</span>Pilot
        </h2>
        ${content}
        <hr style="border: none; border-top: 1px solid #2a2a2a; margin: 32px 0;" />
        <p style="color: #666; font-size: 12px; margin: 0;">ShowPilot — The operating system for live production</p>
      </div>
    </div>
  `;
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
    `),
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
    `),
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
