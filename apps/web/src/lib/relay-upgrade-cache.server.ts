import { resolveEffectiveAccess, type AccessDatabase } from "./effective-access";
import type { Permission } from "./permissions";

const UPGRADE_TTL_MS = 15_000;
const MAX_ENTRIES = 500;

interface SessionIdentity {
  user: { id: string; name: string };
  session: { id: string; expiresAt: Date | string };
}
type SessionLoader = (request: Request) => Promise<SessionIdentity | null>;
interface OrgIdentity {
  userId: string;
  sessionId: string;
  name: string;
  role: string;
  permissions: Permission[];
}
interface Cached<T> { value: T; until: number; userId: string; orgId?: string }

function isUpgrade(request: Request): boolean {
  return request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket"
    && /^\/api\/(?:timecode|rundown|bridge|chat|cue-sheet|lowerthirds)\/[^/]+\/ws$/.test(new URL(request.url).pathname);
}

/** Cache only completed values: request-owned I/O promises never cross requests. */
export class RelayUpgradeCache {
  private sessions = new Map<string, Cached<SessionIdentity>>();
  private orgs = new Map<string, Cached<string>>();
  private identities = new Map<string, Cached<OrgIdentity>>();
  private requestSessions = new WeakMap<Request, Promise<SessionIdentity | null>>();
  private generation = 0;

  constructor(private now: () => number = Date.now) {}

  private read<T>(cache: Map<string, Cached<T>>, key: string): T | null {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.until <= this.now()) { cache.delete(key); return null; }
    return entry.value;
  }

  private remember<T>(cache: Map<string, Cached<T>>, key: string, entry: Cached<T>, generation: number): void {
    if (generation !== this.generation || entry.until <= this.now()) return;
    for (const [oldKey, old] of cache) if (old.until <= this.now()) cache.delete(oldKey);
    if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, entry);
  }

  private deadline(session: SessionIdentity): number {
    return Math.min(this.now() + UPGRADE_TTL_MS, new Date(session.session.expiresAt).getTime());
  }

  private async loadSession(request: Request, load: SessionLoader): Promise<SessionIdentity | null> {
    const authorization = request.headers.get("authorization") ?? "";
    const cookie = request.headers.get("cookie") ?? "";
    if (!authorization && !cookie) return null;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([authorization, cookie])));
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const cached = this.read(this.sessions, key);
    if (cached) return cached;
    const generation = this.generation;
    const session = await load(request).catch(() => null);
    if (!session || !session.session.id || !Number.isFinite(this.deadline(session)) || this.deadline(session) <= this.now()) return null;
    this.remember(this.sessions, key, { value: session, until: this.deadline(session), userId: session.user.id }, generation);
    return session;
  }

  private session(request: Request, load: SessionLoader): Promise<SessionIdentity | null> {
    if (!isUpgrade(request)) return load(request);
    let promise = this.requestSessions.get(request);
    if (!promise) {
      promise = this.loadSession(request, load);
      this.requestSessions.set(request, promise);
    }
    return promise;
  }

  async resolveOrgId(request: Request, slugOrId: string, db: AccessDatabase, load: SessionLoader): Promise<string | null> {
    const session = isUpgrade(request) ? await this.session(request, load) : null;
    const key = JSON.stringify([session?.session.id, slugOrId]);
    const cached = session ? this.read(this.orgs, key) : null;
    if (cached) return cached;
    const generation = this.generation;
    const byId = await db.prepare("SELECT id FROM organization WHERE id = ?").bind(slugOrId).first<{ id: string }>();
    const org = byId ?? await db.prepare("SELECT id FROM organization WHERE slug = ?").bind(slugOrId).first<{ id: string }>();
    if (!org) return null;
    const tombstone = await db.prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'organization-deleting' LIMIT 1")
      .bind(org.id).first<{ value: string }>();
    if (tombstone) return null;
    if (session) this.remember(this.orgs, key, { value: org.id, until: this.deadline(session), userId: session.user.id, orgId: org.id }, generation);
    return org.id;
  }

  async identity(request: Request, orgId: string, db: AccessDatabase, load: SessionLoader): Promise<OrgIdentity | null> {
    try {
      const session = await this.session(request, load);
      if (!session) return null;
      const key = JSON.stringify([session.session.id, orgId]);
      const cached = isUpgrade(request) ? this.read(this.identities, key) : null;
      if (cached) return cached;
      const generation = this.generation;
      const access = await resolveEffectiveAccess(db, session.user.id, orgId);
      if (!access) return null;
      const identity = { userId: session.user.id, sessionId: session.session.id, name: session.user.name, role: access.role, permissions: access.permissions };
      if (isUpgrade(request)) this.remember(this.identities, key, { value: identity, until: this.deadline(session), userId: session.user.id, orgId }, generation);
      return identity;
    } catch { return null; }
  }

  invalidate({ orgId, userId }: { orgId?: string; userId?: string }): void {
    this.generation++;
    for (const cache of [this.sessions, this.orgs, this.identities]) {
      for (const [key, entry] of cache) {
        if ((!orgId || entry.orgId === orgId) && (!userId || entry.userId === userId)) cache.delete(key);
      }
    }
  }
}

export const relayUpgradeCache = new RelayUpgradeCache();
