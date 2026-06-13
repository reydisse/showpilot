import { env } from "cloudflare:workers";
import { z } from "zod";
import { verifyCompanionToken } from "@/lib/companion-token";
import { getCompanionSecret } from "@/lib/companion";
import { getPrisma } from "@/lib/db";
import { isRateLimited } from "@/lib/rate-limit";
import { parseOrThrow, ValidationError } from "@/lib/validation";
import {
  setProPresenterStageDisplayForOrg,
  getProPresenterStageDisplayForOrg,
} from "@/lib/rundown";
import {
  triggerLowerThirdForOrg,
  clearLowerThirdForOrg,
  readLowerThirdForOrg,
} from "@/lib/lowerthirds";
import { setKioskBlanked, getKioskBlanked } from "@/lib/kiosk-display";
import {
  resolveOrgLiveInput,
  connectDestinationsForOrg,
  disconnectAllForOrg,
  getStreamStatusForOrg,
} from "@/lib/stream-destinations";
import type {
  CompanionDeps,
  CompanionResult,
  RelayState,
  LowerThirdLike,
} from "@/lib/companion-control";

// ─────────────────────────────────────────────────────────────
// Companion API HTTP layer: auth, JSON helpers, rate limiting, and the real
// CompanionDeps wired to relays + DB. Mirrors kiosk-api.ts conventions.
// ─────────────────────────────────────────────────────────────

type DB = typeof env.DB;

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  // Control responses must never be cached.
  "Cache-Control": "no-store",
};

export function companionJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: BASE_HEADERS });
}

export function companionError(code: string, message: string, status: number): Response {
  return companionJson({ ok: false, error: code, message }, status);
}

// ─── Auth ────────────────────────────────────────────────────

export interface CompanionAuth {
  orgId: string;
  orgSlug: string;
}

interface AuthFailure {
  error: { code: string; message: string; status: number };
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Validate a `cmp_` bearer token (prefix + HMAC + expiry) and confirm it has
 * not been revoked. Returns the resolved org, or an auth failure to render.
 * The org is taken from the signed payload — never from the request — so a
 * token can only ever act on its own org.
 */
export async function authenticateCompanion(
  request: Request,
): Promise<CompanionAuth | AuthFailure> {
  const token = bearer(request);
  if (!token) {
    return { error: { code: "unauthorized", message: "Missing companion token", status: 401 } };
  }

  let payload: Record<string, unknown> | null;
  try {
    payload = await verifyCompanionToken(token, getCompanionSecret());
  } catch {
    // Fail closed if COMPANION_SECRET is unset.
    return { error: { code: "unauthorized", message: "Companion control is not configured", status: 401 } };
  }
  if (!payload || typeof payload.orgId !== "string") {
    return { error: { code: "unauthorized", message: "Invalid or expired companion token", status: 401 } };
  }

  const row = await (env.DB as DB)
    .prepare("SELECT revokedAt, orgId FROM companion_token WHERE token = ? LIMIT 1")
    .bind(token)
    .first<{ revokedAt: unknown; orgId: string }>();
  if (!row || row.revokedAt) {
    return { error: { code: "unauthorized", message: "Revoked or unknown companion token", status: 401 } };
  }

  return { orgId: payload.orgId, orgSlug: (payload.orgSlug as string) ?? "" };
}

// ─── Relay helpers ───────────────────────────────────────────

interface CompanionEnv {
  RUNDOWN_RELAY: DurableObjectNamespace;
  LOWER_THIRDS_RELAY: DurableObjectNamespace;
}

async function rundownRelayCommand(
  orgId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const bindings = env as unknown as CompanionEnv;
  const id = bindings.RUNDOWN_RELAY.idFromName(orgId);
  const stub = bindings.RUNDOWN_RELAY.get(id);
  await stub.fetch(
    new Request(`https://rundown.local/command?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
    }),
  );
}

async function rundownRelayState(orgId: string): Promise<RelayState> {
  const bindings = env as unknown as CompanionEnv;
  const id = bindings.RUNDOWN_RELAY.idFromName(orgId);
  const stub = bindings.RUNDOWN_RELAY.get(id);
  const res = await stub.fetch(
    new Request(`https://rundown.local/state?orgId=${encodeURIComponent(orgId)}`),
  );
  const data = (await res.json()) as Partial<RelayState>;
  return {
    items: Array.isArray(data.items) ? data.items : [],
    timer: data.timer ?? {
      playback: "stop",
      currentItemId: null,
      elapsed: 0,
      startedAt: null,
      pausedAt: null,
      mode: "count-down",
    },
    stageMessage: data.stageMessage ?? "",
  };
}

async function lowerThirdsRelayTrigger(orgId: string, payload: Record<string, unknown>): Promise<void> {
  const bindings = env as unknown as CompanionEnv;
  const id = bindings.LOWER_THIRDS_RELAY.idFromName(orgId);
  const stub = bindings.LOWER_THIRDS_RELAY.get(id);
  await stub.fetch(
    new Request("https://lt.local/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

async function lowerThirdsRelayClear(orgId: string): Promise<void> {
  const bindings = env as unknown as CompanionEnv;
  const id = bindings.LOWER_THIRDS_RELAY.idFromName(orgId);
  const stub = bindings.LOWER_THIRDS_RELAY.get(id);
  await stub.fetch(new Request("https://lt.local/clear", { method: "POST" }));
}

async function isCloudEnabled(orgId: string): Promise<boolean> {
  const prisma = getPrisma();
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { cloud_enabled: true },
  });
  return Boolean(org?.cloud_enabled);
}

// ─── Real deps ───────────────────────────────────────────────

export function buildCompanionDeps(): CompanionDeps {
  return {
    relayCommand: rundownRelayCommand,
    relayState: rundownRelayState,
    setLyrics: setProPresenterStageDisplayForOrg,
    getLyrics: getProPresenterStageDisplayForOrg,
    isCloudEnabled,
    async triggerLowerThird(orgId, payload: LowerThirdLike, triggeredBy) {
      const stored = await triggerLowerThirdForOrg(
        orgId,
        payload as Parameters<typeof triggerLowerThirdForOrg>[1],
        triggeredBy,
      );
      // Broadcast to the LT relay so overlays/confidence monitors update live.
      await lowerThirdsRelayTrigger(orgId, stored as unknown as Record<string, unknown>);
      return stored;
    },
    async clearLowerThird(orgId) {
      await clearLowerThirdForOrg(orgId);
      await lowerThirdsRelayClear(orgId);
    },
    getLowerThird: readLowerThirdForOrg,
    setKioskBlank: setKioskBlanked,
    getKioskBlank: getKioskBlanked,
    async streamGoLive(orgId) {
      const input = await resolveOrgLiveInput(orgId);
      if (!input) {
        return { status: 409, error: "No live input configured" };
      }
      const results = await connectDestinationsForOrg(orgId, input.id);
      return { status: 200, results };
    },
    async streamStop(orgId) {
      await disconnectAllForOrg(orgId);
    },
    streamStatus: getStreamStatusForOrg,
  };
}

// ─── Request wrapper ─────────────────────────────────────────

const RATE_LIMIT = { max: 120, windowSeconds: 60 };

interface RunOptions<S extends z.ZodType> {
  request: Request;
  schema?: S;
  handler: (ctx: {
    orgId: string;
    orgSlug: string;
    body: S extends z.ZodType ? z.output<S> : undefined;
    deps: CompanionDeps;
  }) => Promise<CompanionResult>;
}

/**
 * Shared pipeline for every companion endpoint: authenticate the `cmp_`
 * token, rate-limit per org, zod-validate the JSON body (when a schema is
 * given), then dispatch to the handler and render its CompanionResult.
 */
export async function runCompanion<S extends z.ZodType>(opts: RunOptions<S>): Promise<Response> {
  const auth = await authenticateCompanion(opts.request);
  if ("error" in auth) {
    return companionError(auth.error.code, auth.error.message, auth.error.status);
  }

  if (await isRateLimited(`companion:${auth.orgId}`, RATE_LIMIT)) {
    return companionError("rate_limited", "Too many requests", 429);
  }

  let body: unknown = undefined;
  if (opts.schema) {
    let raw: unknown = {};
    try {
      const text = await opts.request.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return companionError("bad_request", "Body must be valid JSON", 400);
    }
    try {
      body = parseOrThrow(opts.schema, raw);
    } catch (err) {
      const message = err instanceof ValidationError ? err.message : "Invalid request body";
      return companionError("bad_request", message, 400);
    }
  }

  const deps = buildCompanionDeps();
  const result = await opts.handler({
    orgId: auth.orgId,
    orgSlug: auth.orgSlug,
    body: body as never,
    deps,
  });
  return companionJson(result.body, result.status);
}
