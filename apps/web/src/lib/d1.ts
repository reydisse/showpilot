import { env } from "cloudflare:workers";

// Raw D1 access, isolated in its own module so callers don't import
// `cloudflare:workers` directly. Importing that virtual module in the same
// file as `@tanstack/react-start/server` helpers (e.g. getRequestHeaders)
// breaks their resolution in the worker SSR environment — keep them separate.
export function getD1() {
  return env.DB;
}
