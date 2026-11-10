import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail, EmailDeliveryRejected, invitationEmail } from "../email";

const mocks = vi.hoisted(() => ({
  env: { RESEND_API_KEY: "test-api-key" as string | undefined },
}));

vi.mock("cloudflare:workers", () => ({ env: mocks.env }));

const message = {
  to: "person@example.com",
  subject: "Reset your password",
  html: '<a href="https://showpilot.tech/reset-password?token=secret-reset-token">Reset</a>',
};

describe("email delivery privacy", () => {
  beforeEach(() => {
    mocks.env.RESEND_API_KEY = "test-api-key";
    vi.restoreAllMocks();
  });

  it("does not log recipient or message data after a successful delivery", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: "email-1", recipient: message.to }),
      { status: 200 },
    )));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendEmail(message)).resolves.toBeUndefined();

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not expose provider bodies, recipients, or reset tokens on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `Rejected ${message.to}: secret-reset-token`,
      { status: 422, headers: { "x-request-id": "request-1" } },
    )));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendEmail(message)).rejects.toThrow("Email send failed with status 422.");

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("request-1");
    expect(logged).not.toContain(message.to);
    expect(logged).not.toContain("secret-reset-token");
  });

  it("fails without disclosing configuration or message data when email is unavailable", async () => {
    mocks.env.RESEND_API_KEY = undefined;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendEmail(message)).rejects.toThrow("Email service not configured");

    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain(message.to);
    expect(logged).not.toContain("secret-reset-token");
    expect(logged).not.toContain("test-api-key");
  });
});


describe("invitation delivery evidence", () => {
  beforeEach(() => { mocks.env.RESEND_API_KEY = "fixture-key"; vi.restoreAllMocks(); });
  it("sends the stable provider key with the frozen payload and cancellation signal", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "accepted-id" }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await sendEmail({ ...message, idempotencyKey: "team-invitation/frozen-id", signal });
    expect(fetch).toHaveBeenCalledWith("https://api.resend.com/emails", expect.objectContaining({ signal,
      headers: expect.objectContaining({ "Idempotency-Key": "team-invitation/frozen-id" }),
      body: JSON.stringify({ from: "ShowPilot <noreply@showpilot.tech>", ...message }),
    }));
  });
  it.each([408, 409, 500, 503])("keeps HTTP %i uncertain instead of claiming the email was rejected", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider detail", { status })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = sendEmail({ ...message, idempotencyKey: "same-attempt" });
    await expect(result).rejects.toThrow("could not be confirmed");
    await expect(result).rejects.not.toBeInstanceOf(EmailDeliveryRejected);
  });
  it("recognizes a definite validation rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider detail", { status: 422 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendEmail({ ...message, idempotencyKey: "same-attempt" })).rejects.toBeInstanceOf(EmailDeliveryRejected);
  });
  it.each(["{}", "null", '{"id":""}', "invalid-json"])("does not infer acceptance from HTTP 200 with %s", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(sendEmail({ ...message, idempotencyKey: "same-attempt" })).rejects.toThrow();
  });
  it("renders organization and inviter text without interpreting their HTML", () => {
    const result = invitationEmail('<img src=x onerror="alert(1)">', "A & B", 'https://example.test/invite/a?x="&y=1');
    expect(result.html).toContain("&lt;img");
    expect(result.html).toContain("A &amp; B");
    expect(result.html).toContain("?x=&quot;&amp;y=1");
    expect(result.html).not.toContain('<img src=x');
  });
});
