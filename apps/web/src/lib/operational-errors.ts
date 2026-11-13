import { z } from "zod";

export const OPERATIONAL_ERRORS = {
  browser_error: { source: "browser", message: "The browser encountered an unexpected error." },
  browser_rejection: { source: "browser", message: "A browser operation failed unexpectedly." },
  bridge_socket_setup: { source: "BridgeRelay", message: "Bridge connection setup failed." },
  bridge_clock_cleanup: { source: "BridgeRelay", message: "Disconnected Bridge clock cleanup failed." },
  bridge_preview_update: { source: "BridgeRelay", message: "The preview slide could not be forwarded." },
  bridge_preview_clear: { source: "BridgeRelay", message: "The preview clear could not be forwarded." },
  rundown_activation: { source: "RundownRelay", message: "Show activation could not be confirmed." },
  rundown_persistence: { source: "RundownRelay", message: "The rundown change could not be saved." },
  chat_gateway_operation: { source: "ChatRelay", message: "An external chat operation failed." },
  chat_gateway_sync: { source: "ChatRelay", message: "External chat synchronization failed." },
  chat_attachment_cleanup: { source: "ChatRelay", message: "Deleted chat attachment cleanup was not confirmed." },
  chat_mutation: { source: "ChatRelay", message: "A chat message change could not be confirmed." },
} as const;
export type OperationalErrorCode = keyof typeof OPERATIONAL_ERRORS;
export const errorNameSchema = z.enum(["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError", "URIError", "AggregateError", "AbortError", "Unknown"]);
export type SafeErrorName = z.infer<typeof errorNameSchema>;
export const browserErrorSchema = z.object({
  code: z.enum(["browser_error", "browser_rejection"]),
  errorName: errorNameSchema,
  // Build asset basename only: no URL, query, stack, user text or device payload.
  asset: z.string().max(120).regex(/^[A-Za-z0-9_$.-]+\.js$/).optional(),
  line: z.number().int().min(0).max(10_000_000).optional(),
  column: z.number().int().min(0).max(10_000_000).optional(),
}).strict();
export type BrowserErrorReport = z.infer<typeof browserErrorSchema>;
export function safeErrorName(error: unknown): SafeErrorName {
  try {
    const parsed = errorNameSchema.safeParse(error instanceof Error || error instanceof DOMException ? error.name : "Unknown");
    return parsed.success ? parsed.data : "Unknown";
  } catch { return "Unknown"; }
}
