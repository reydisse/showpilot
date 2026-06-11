import { env } from "cloudflare:workers";
import { verifyToken, getKioskSecret } from "@/lib/kiosk";

// ─────────────────────────────────────────────────────────────
// Kiosk API — read-only endpoints behind a kiosk Bearer token.
// Implements showpilot-kiosk-api-contract.md. Uses raw D1 (matching the
// worker-level routes in server.ts) so it needs no Prisma client changes.
// People reuse the "user" table; assets reuse "equipment".
// ─────────────────────────────────────────────────────────────

type DB = typeof env.DB;
const db = (): DB => env.DB;

// ─── HTTP helpers (contract conventions) ─────────────────────

const BASE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

export function kioskJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...BASE_HEADERS,
      // Kiosk polls every 60s; allow edge/browser caching for that window.
      "Cache-Control": status === 200 ? "public, max-age=60" : "no-store",
    },
  });
}

export function kioskError(code: string, message: string, status: number) {
  return kioskJson({ error: { code, message } }, status);
}

// ─── Auth ────────────────────────────────────────────────────

export interface KioskAuth {
  orgId: string;
  orgSlug: string;
}

interface AuthFailure {
  error: { code: string; message: string; status: number };
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // LAN-only fallback: ?key= (see contract). Prefer the Bearer token.
  const key = new URL(request.url).searchParams.get("key");
  return key && key.trim() ? key.trim() : null;
}

/**
 * Validates the kiosk token (HMAC signature + expiry) and confirms it hasn't
 * been revoked. Returns the resolved org, or an auth failure to render.
 */
export async function authenticateKiosk(
  request: Request,
): Promise<KioskAuth | AuthFailure> {
  const token = bearer(request);
  if (!token) {
    return { error: { code: "unauthorized", message: "Missing kiosk token", status: 401 } };
  }
  const payload = await verifyToken(token, getKioskSecret());
  if (!payload || typeof payload.orgId !== "string") {
    return { error: { code: "unauthorized", message: "Invalid or expired kiosk token", status: 401 } };
  }
  const row = await db()
    .prepare("SELECT revokedAt, orgId FROM kiosk_token WHERE token = ? LIMIT 1")
    .bind(token)
    .first<{ revokedAt: unknown; orgId: string }>();
  if (!row || row.revokedAt) {
    return { error: { code: "unauthorized", message: "Revoked or unknown kiosk token", status: 401 } };
  }
  return { orgId: payload.orgId, orgSlug: (payload.orgSlug as string) ?? "" };
}

// ─── Shaping helpers ─────────────────────────────────────────

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// D1/Prisma may store DATETIME as epoch ms (number/numeric string) or a
// date string — normalize everything to ISO 8601 UTC.
function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return new Date(Number(v)).toISOString();
    const s = v.includes("T") ? v : v.replace(" ", "T");
    const hasTz = s.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(s);
    const d = new Date(hasTz ? s : `${s}Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

interface PersonRow {
  id: string;
  name: string;
  image: string | null;
}
function person(r: PersonRow) {
  return { id: r.id, name: r.name, initials: initials(r.name), avatarUrl: r.image ?? null };
}

const nullable = (s: string | null | undefined) => (s && s.length ? s : null);

// ─── Endpoint 1: Org structure ───────────────────────────────

export async function getOrgStructure(orgId: string) {
  const org = await db()
    .prepare("SELECT id, name FROM organization WHERE id = ? LIMIT 1")
    .bind(orgId)
    .first<{ id: string; name: string }>();
  if (!org) return null;

  // Apex of the chart is the Technical Manager (tm). Fall back to owner/admin
  // only so the slot isn't empty in orgs that haven't assigned a TM yet.
  const tm = await db()
    .prepare(
      `SELECT u.id AS id, u.name AS name, u.image AS image, m.role AS role
       FROM member m JOIN user u ON u.id = m.userId
       WHERE m.organizationId = ?
       ORDER BY CASE m.role WHEN 'tm' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END
       LIMIT 1`,
    )
    .bind(orgId)
    .first<{ id: string; name: string; image: string | null; role: string }>();

  const teamRows =
    (
      await db()
        .prepare("SELECT id, name, color, sortOrder FROM team WHERE orgId = ? ORDER BY sortOrder, name")
        .bind(orgId)
        .all<{ id: string; name: string; color: string; sortOrder: number }>()
    ).results ?? [];

  const teams = [];
  for (const t of teamRows) {
    const mem =
      (
        await db()
          .prepare(
            `SELECT u.id AS id, u.name AS name, u.image AS image, tm.role AS role
             FROM team_member tm JOIN user u ON u.id = tm.userId
             WHERE tm.teamId = ?
             ORDER BY CASE tm.role WHEN 'lead' THEN 0 ELSE 1 END, tm.sortOrder, u.name`,
          )
          .bind(t.id)
          .all<PersonRow & { role: string }>()
      ).results ?? [];

    const leadRow = mem.find((x) => x.role === "lead") ?? null;
    teams.push({
      id: t.id,
      name: t.name,
      color: t.color,
      sortOrder: t.sortOrder,
      lead: leadRow ? person(leadRow) : null,
      members: mem.filter((x) => x.role !== "lead").map(person),
    });
  }

  const ROLE_TITLE: Record<string, string> = {
    tm: "Technical Manager",
    owner: "Owner",
    admin: "Admin",
    pm: "Production Manager",
    sm: "Stage Manager",
  };

  return {
    organization: { id: org.id, name: org.name },
    technicalManager: tm
      ? {
          id: tm.id,
          name: tm.name,
          title: ROLE_TITLE[tm.role] ?? "Technical Manager",
          initials: initials(tm.name),
          avatarUrl: tm.image ?? null,
        }
      : null,
    teams,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Endpoint 2: On-duty roster ──────────────────────────────

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
}
function todayDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function orgTimezone(orgId: string): Promise<string> {
  const row = await db()
    .prepare("SELECT value FROM app_setting WHERE orgId = ? AND key = 'timezone' LIMIT 1")
    .bind(orgId)
    .first<{ value: string }>();
  return row?.value || "UTC";
}

export async function getRoster(orgId: string, month?: string | null) {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : currentMonth();
  const timezone = await orgTimezone(orgId);

  const roleRows =
    (
      await db()
        .prepare("SELECT id, code, name, short FROM roster_role WHERE orgId = ? ORDER BY sortOrder, code")
        .bind(orgId)
        .all<{ id: string; code: string; name: string; short: string }>()
    ).results ?? [];
  const codeById = new Map(roleRows.map((r) => [r.id, r.code]));

  const assignments =
    (
      await db()
        .prepare(
          `SELECT a.weekStart AS weekStart, a.kind AS kind, a.roleId AS roleId, u.id AS userId, u.name AS name
           FROM roster_assignment a JOIN user u ON u.id = a.userId
           WHERE a.orgId = ? AND a.weekStart >= ? AND a.weekStart <= ?
           ORDER BY a.weekStart`,
        )
        .bind(orgId, `${m}-01`, `${m}-31`)
        .all<{ weekStart: string; kind: string; roleId: string | null; userId: string; name: string }>()
    ).results ?? [];

  interface WeekAcc {
    tech: { roleId: string | null; person: { id: string; name: string; initials: string } }[];
    pm: { id: string; name: string; initials: string } | null;
  }
  const byWeek = new Map<string, WeekAcc>();
  for (const a of assignments) {
    let w = byWeek.get(a.weekStart);
    if (!w) {
      w = { tech: [], pm: null };
      byWeek.set(a.weekStart, w);
    }
    const p = { id: a.userId, name: a.name, initials: initials(a.name) };
    if (a.kind === "pm") {
      w.pm = p;
    } else {
      w.tech.push({ roleId: a.roleId ? codeById.get(a.roleId) ?? a.roleId : null, person: p });
    }
  }

  const today = todayDate();
  const weeks = [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([weekStart, w]) => {
      const weekEnd = addDays(weekStart, 6);
      return {
        weekStart,
        weekEnd,
        isCurrent: today >= weekStart && today <= weekEnd,
        tech: w.tech,
        pm: w.pm,
      };
    });

  return {
    month: m,
    timezone,
    techRoles: roleRows.map((r) => ({ id: r.code, name: r.name, short: r.short })),
    weeks,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Endpoint 3: Asset status ────────────────────────────────

// Equipment statuses → contract kiosk statuses.
const ASSET_STATUS: Record<string, string> = {
  operational: "operational",
  "needs-repair": "degraded",
  "out-of-service": "down",
  "in-repair": "maintenance",
  retired: "retired",
};
function mapStatus(s: string): string {
  return ASSET_STATUS[s] ?? "operational";
}

export async function getAssets(orgId: string) {
  const rows =
    (
      await db()
        .prepare(
          `SELECT id, name, category, status, location, notes, lastServiced, updatedAt
           FROM equipment WHERE orgId = ? ORDER BY category, name`,
        )
        .bind(orgId)
        .all<{
          id: string;
          name: string;
          category: string;
          status: string;
          location: string | null;
          notes: string | null;
          lastServiced: unknown;
          updatedAt: unknown;
        }>()
    ).results ?? [];

  const summary = { total: rows.length, operational: 0, degraded: 0, down: 0, maintenance: 0, retired: 0 };
  const assets = rows.map((r) => {
    const status = mapStatus(r.status);
    if (status in summary) (summary as Record<string, number>)[status] += 1;
    return {
      id: r.id,
      name: r.name,
      category: r.category,
      status,
      location: nullable(r.location),
      ipAddress: null,
      lastCheckedAt: toIso(r.lastServiced) ?? toIso(r.updatedAt),
      note: nullable(r.notes),
    };
  });

  return { summary, assets, updatedAt: new Date().toISOString() };
}
