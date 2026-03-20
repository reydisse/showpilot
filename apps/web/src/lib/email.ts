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

// ─── Email Templates ────────────────────────────────────────

export function passwordResetEmail(resetUrl: string) {
  return {
    subject: "Reset your ShowPilot password",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #f5f5f5; font-size: 24px; margin-bottom: 8px;">
          <span style="color: #FFC107;">Show</span>Pilot
        </h2>
        <p style="color: #a0a0a0; font-size: 14px; margin-bottom: 32px;">Password Reset</p>
        <p style="color: #d4d4d4; font-size: 15px; line-height: 1.6;">
          Someone requested a password reset for your account. Click the button below to set a new password.
        </p>
        <a href="${resetUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background: linear-gradient(135deg, #FFC107, #FF8F00); color: #000; font-weight: 600; text-decoration: none; border-radius: 8px; font-size: 15px;">
          Reset Password
        </a>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          If you didn't request this, you can safely ignore this email. The link expires in 1 hour.
        </p>
        <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;" />
        <p style="color: #666; font-size: 12px;">ShowPilot — Live Production Management</p>
      </div>
    `,
  };
}

export function invitationEmail(orgName: string, inviterName: string, inviteUrl: string) {
  return {
    subject: `You're invited to join ${orgName} on ShowPilot`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #f5f5f5; font-size: 24px; margin-bottom: 8px;">
          <span style="color: #FFC107;">Show</span>Pilot
        </h2>
        <p style="color: #a0a0a0; font-size: 14px; margin-bottom: 32px;">Team Invitation</p>
        <p style="color: #d4d4d4; font-size: 15px; line-height: 1.6;">
          <strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on ShowPilot.
        </p>
        <a href="${inviteUrl}" style="display: inline-block; margin: 24px 0; padding: 12px 32px; background: linear-gradient(135deg, #FFC107, #FF8F00); color: #000; font-weight: 600; text-decoration: none; border-radius: 8px; font-size: 15px;">
          Accept Invitation
        </a>
        <p style="color: #888; font-size: 13px; line-height: 1.5;">
          If you don't have a ShowPilot account, you'll be asked to create one first.
        </p>
        <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;" />
        <p style="color: #666; font-size: 12px;">ShowPilot — Live Production Management</p>
      </div>
    `,
  };
}
