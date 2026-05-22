export const env = (globalThis as { env?: Record<string, unknown> }).env ?? {};
