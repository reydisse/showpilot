import { APIError } from "better-auth/api";
import { expect, it } from "vitest";
import { AccessCheckUnavailableError, accessCheckUnavailableResponse, isAuthenticationDenial } from "../access-check-errors.server";

it("distinguishes deliberate authentication denials from internal failures", () => {
  expect(isAuthenticationDenial(new APIError("UNAUTHORIZED"))).toBe(true);
  expect(isAuthenticationDenial(new APIError("FORBIDDEN"))).toBe(true);
  expect(isAuthenticationDenial(new APIError("INTERNAL_SERVER_ERROR"))).toBe(false);
  expect(isAuthenticationDenial(new Error("Database unavailable"))).toBe(false);
});

it("returns a non-cacheable retryable response without exposing the internal cause", async () => {
  const cause = new Error("private database detail");
  const error = new AccessCheckUnavailableError(cause);
  expect(error.cause).toBe(cause);
  const response = accessCheckUnavailableResponse();
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Retry-After")).toBe("1");
  expect(await response.text()).not.toContain(cause.message);
});
