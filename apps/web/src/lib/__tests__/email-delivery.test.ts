import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../email";

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
