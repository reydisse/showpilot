import { APIError } from "better-auth/api";

const unavailableMessage = "Access checks are temporarily unavailable. Retry the connection.";

export function isAuthenticationDenial(error: unknown): boolean {
  return error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403);
}

export class AccessCheckUnavailableError extends Error {
  constructor(cause: unknown) {
    super(unavailableMessage, { cause });
    this.name = "AccessCheckUnavailableError";
  }
}

export function accessCheckUnavailableResponse(): Response {
  return Response.json({ error: unavailableMessage, code: "access_unavailable" }, {
    status: 503,
    headers: { "Cache-Control": "private, no-store", "Retry-After": "1" },
  });
}
