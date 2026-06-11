import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Shared input validation for server functions and API routes.
// Every POST server function validates its input with one of these
// schemas (or a local zod schema) via parseOrThrow before touching
// the database.
// ─────────────────────────────────────────────────────────────

/** Org slugs: lowercase alphanumeric + hyphens, 3–40 chars. */
export const orgSlugSchema = z
  .string()
  .regex(/^[a-z0-9-]{3,40}$/, "Slug must be 3-40 lowercase letters, numbers, or hyphens");

export const emailSchema = z.email("Invalid email address").max(254);

/** Generic entity IDs (cuid/uuid/nanoid): non-empty, bounded. */
export const idSchema = z.string().min(1, "ID is required").max(64);

/** Short human-entered labels/names. */
export const labelSchema = z.string().min(1).max(200);

/** Free-form text fields (notes, descriptions, messages). */
export const textSchema = z.string().max(10_000);

/** ISO-ish service date keys, e.g. "2026-06-09". */
export const serviceDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export class ValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Parse `data` with `schema`; throw a 400-style ValidationError carrying the
 * first issue message if it fails. Use inside `.inputValidator()` so handlers
 * receive fully-typed, validated data.
 */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length ? `${first.path.join(".")}: ` : "";
    throw new ValidationError(`${path}${first.message}`);
  }
  return result.data;
}
