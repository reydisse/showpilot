import { describe, expect, it } from "vitest";
import { auth } from "../auth";

describe("Better Auth organization deletion boundary", () => {
  it("disables the native deletion endpoint in favor of the guarded ShowPilot workflow", async () => {
    const response = await auth.handler(new Request("http://localhost:3000/api/auth/organization/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost:3000",
      },
      body: JSON.stringify({ organizationId: "disposable-org" }),
    }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "ORGANIZATION_DELETION_DISABLED",
    });
  });
});
