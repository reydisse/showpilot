import { z } from "zod";
import { createBrowserId } from "./browser-id";
import { isLiveRundownTransport, RUNDOWN_TRANSPORT_MAX_AGE_MS } from "./rundown-command-protocol";

const failureReason = z.enum(["unconfirmed", "rejected", "expired", "interrupted"]);
const noticeSchema = z.object({
  id: z.string(),
  serviceDate: z.string().optional(),
  showId: z.string().optional(),
  count: z.number().int().positive(),
  occurredAt: z.number().finite(),
}).and(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("failed"), reason: failureReason }),
]));
export type RundownHandoffNotice = z.infer<typeof noticeSchema>;
export interface RundownHandoffCommand {
  queuedAt: number;
  id: string;
  action: string;
  payload?: Record<string, unknown>;
  expectedRevision?: number;
}
interface Handoff {
  orgId: string;
  serviceDate?: string;
  showId?: string;
  view: "rundown" | "show";
  revision: number;
  serverClockOffset: number | null;
  commands: readonly RundownHandoffCommand[];
}

const notices = new Map<string, readonly RundownHandoffNotice[]>();
const EMPTY: readonly RundownHandoffNotice[] = [];
const CHANGE_EVENT = "showpilot:rundown-handoff";
const storageKey = (orgId: string) => `showpilot:rundown-handoff:${orgId}`;

export function readRundownHandoffs(orgId: string): readonly RundownHandoffNotice[] {
  if (typeof window === "undefined") return EMPTY;
  const cached = notices.get(orgId);
  if (cached) return cached;
  let restored: readonly RundownHandoffNotice[] = EMPTY;
  try {
    const parsed = z.array(noticeSchema).safeParse(JSON.parse(sessionStorage.getItem(storageKey(orgId)) ?? "[]"));
    // A previous document cannot confirm work after a reload. Preserve the
    // warning, but never restore or replay command bodies from browser storage.
    if (parsed.success) restored = parsed.data.map(notice => notice.kind === "pending"
      ? { ...notice, kind: "failed", reason: "interrupted" } : notice);
  } catch { /* Storage can be disabled. In-memory notices still work. */ }
  notices.set(orgId, restored);
  return restored;
}

function saveNotices(orgId: string, next: readonly RundownHandoffNotice[]): void {
  notices.set(orgId, next);
  try {
    if (next.length) sessionStorage.setItem(storageKey(orgId), JSON.stringify(next));
    else sessionStorage.removeItem(storageKey(orgId));
  } catch { /* A storage failure must not hide the in-memory warning. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function dismissRundownHandoff(orgId: string, id: string): void {
  saveNotices(orgId, readRundownHandoffs(orgId).filter(notice => notice.id !== id || notice.kind === "pending"));
}

export function subscribeRundownHandoffs(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/** Called on route teardown. Preserve ordering, identity, revision and live deadlines. */
export async function handOffRundownCommands(handoff: Handoff): Promise<void> {
  const { orgId, serviceDate, showId, commands, serverClockOffset } = handoff;
  if (!commands.length) return;
  const id = createBrowserId();
  const base = { id, serviceDate, showId, occurredAt: Date.now() };
  const update = (notice: RundownHandoffNotice | null) => {
    const others = readRundownHandoffs(orgId).filter(entry => entry.id !== id);
    saveNotices(orgId, notice ? [...others, notice] : others);
  };
  update({ ...base, kind: "pending", count: commands.length });
  const query = new URLSearchParams();
  if (serviceDate) query.set("serviceDate", serviceDate);
  if (showId) query.set("showId", showId);
  if (handoff.view === "show") query.set("view", "show");
  const url = `${window.location.origin}/api/rundown/${encodeURIComponent(orgId)}/command?${query}`;
  let revision = handoff.revision;
  let remaining = commands.length;
  for (const command of commands) {
    const live = isLiveRundownTransport(command.action);
    if (live && (serverClockOffset === null || Date.now() - command.queuedAt >= RUNDOWN_TRANSPORT_MAX_AGE_MS)) {
      update({ ...base, kind: "failed", reason: "expired", count: remaining, occurredAt: Date.now() });
      return;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // The deadline includes response-body reads. Race as well as abort so a
      // stalled transport cannot leave a permanent pending notice.
      const response = await Promise.race([
        (async () => {
          const result = await fetch(url, {
            method: "POST", credentials: "same-origin", keepalive: true,
            signal: controller.signal, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: command.action, id: command.id,
              expectedRevision: command.expectedRevision ?? revision,
              payload: command.payload,
              ...(live ? { expiresAt: command.queuedAt + RUNDOWN_TRANSPORT_MAX_AGE_MS + (serverClockOffset ?? 0) } : {}),
            }),
          });
          if (!result.ok) return { kind: "rejected" } as const;
          const body: unknown = await result.json();
          const accepted = z.object({ ok: z.literal(true), revision: z.number().int().nonnegative() }).safeParse(body);
          return accepted.success ? { kind: "accepted", revision: accepted.data.revision } as const : { kind: "unconfirmed" } as const;
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error("Rundown confirmation timed out")); }, 8_000);
        }),
      ]);
      if (response.kind !== "accepted") {
        update({ ...base, kind: "failed", reason: response.kind, count: remaining, occurredAt: Date.now() });
        return;
      }
      revision = response.revision;
      remaining--;
      update(remaining ? { ...base, kind: "pending", count: remaining } : null);
    } catch {
      update({ ...base, kind: "failed", reason: "unconfirmed", count: remaining, occurredAt: Date.now() });
      return;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
