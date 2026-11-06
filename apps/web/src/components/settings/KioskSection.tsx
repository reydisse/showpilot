import { useOperatorRead } from "@/hooks/useOperatorRead";
import { ReadFailureNotice } from "@/components/layout/ReadFailureNotice";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreatedTokenNotice } from "./CreatedTokenNotice";
import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Crown,
  X,
  Users,
  CalendarDays,
  KeyRound,
} from "lucide-react";
import {
  getKioskTeams,
  getRosterRoles,
  createTeam,
  updateTeam,
  deleteTeam,
  setTeamMember,
  removeTeamMember,
  seedRosterRoles,
  createRosterRole,
  deleteRosterRole,
  getRosterWeek,
  saveRosterWeek,
  type AdminTeam,
  type RosterRole,
} from "@/lib/kiosk-admin";
import {
  createKioskToken,
  listKioskTokens,
  revokeKioskToken,
} from "@/lib/kiosk";
import { getKioskBlankState, setKioskBlankState } from "@/lib/kiosk-display";
import { MonitorOff, Monitor } from "lucide-react";

type Member = { id: string; name: string; image: string | null };

const TEAM_COLORS = [
  "#22d3ee", "#3b82f6", "#8b5cf6", "#ec4899",
  "#f43f5e", "#f59e0b", "#10b981", "#64748b",
];

function snapSunday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// ─── Section entry point (rendered inside the Settings page) ──

export function KioskSection({
  orgId,
  slug,
  members: rawMembers,
}: {
  orgId: string;
  slug: string;
  members: Array<{ user: { id: string; name: string; image: string | null } }>;
}) {
  const members: Member[] = rawMembers.map((m) => ({
    id: m.user.id,
    name: m.user.name,
    image: m.user.image,
  }));

  const [tab, setTab] = useState<"org" | "roster" | "tokens">("org");
  const readOrganization = useCallback(async (signal: AbortSignal) => {
    const [teams, roles] = await Promise.all([
      getKioskTeams({ data: { orgId }, signal }),
      getRosterRoles({ data: { orgId }, signal }),
    ]);
    return { teams, roles };
  }, [orgId]);
  const organizationRead = useOperatorRead<{ teams: AdminTeam[]; roles: RosterRole[] } | null>({
    key: orgId, initialValue: null, read: readOrganization,
    errorMessage: "Could not read the kiosk organization. Any displayed teams and roles are the last confirmed result.",
  });
  const { teams, roles } = organizationRead.value ?? { teams: [], roles: [] };
  const loading = organizationRead.value === null && !organizationRead.error;
  const reload = organizationRead.invalidate;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Kiosk Displays
        </h1>
        <p className="text-xs text-board-muted mt-0.5">
          Org chart and on-duty roster shown on lobby / booth displays
        </p>
      </div>

      <BlankDisplaysToggle orgId={orgId} />

      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {[
          { id: "org" as const, label: "Org Chart", icon: Users },
          { id: "roster" as const, label: "On-Duty Roster", icon: CalendarDays },
          { id: "tokens" as const, label: "Access Tokens", icon: KeyRound },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex min-h-11 items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                  : "text-board-muted hover:text-board-text border border-transparent"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "tokens" ? <AccessTokensTab key={orgId} orgId={orgId} slug={slug} /> : <>
        <ReadFailureNotice error={organizationRead.error} refreshing={organizationRead.refreshing} retry={organizationRead.retry} label="Retry kiosk organization" />
        {loading ? (
          <div className="py-10 text-center text-sm text-board-muted">Loading kiosk organization…</div>
        ) : organizationRead.value === null ? null : tab === "org" ? (
          <OrgChartTab key={orgId} orgId={orgId} teams={teams} members={members} onChange={reload} />
        ) : (
          <RosterTab key={orgId} orgId={orgId} roles={roles} members={members} onChange={reload} />
        )}
      </>}

      <p className="mt-8 text-[10px] text-board-muted/50">
        Live at <code className="text-board-muted">/api/v1/kiosk/org</code> and{" "}
        <code className="text-board-muted">/api/v1/kiosk/roster</code> for org{" "}
        <span className="font-mono">{slug}</span> (kiosk token required).
      </p>
    </div>
  );
}

// ─── Blank Displays toggle ───────────────────────────────────

function BlankDisplaysToggle({ orgId }: { orgId: string }) {
  const [blanked, setBlanked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getKioskBlankState({ data: { orgId } })
      .then((r) => setBlanked(r.blanked))
      .catch(() => {});
  }, [orgId]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = !blanked;
    setBlanked(next); // optimistic
    try {
      await setKioskBlankState({ data: { orgId, blanked: next } });
    } catch {
      setBlanked(!next); // revert
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 mb-5 ${
        blanked ? "border-red-500/40 bg-red-500/5" : "border-board-border bg-board-card"
      }`}
    >
      {blanked ? (
        <MonitorOff className="w-4 h-4 text-red-400 shrink-0" />
      ) : (
        <Monitor className="w-4 h-4 text-board-muted shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-board-text">Blank displays</div>
        <div className="text-[11px] text-board-muted">
          {blanked
            ? "All kiosk displays are showing a black slate."
            : "Hide all kiosk displays instantly (also Stream Deck button 9)."}
        </div>
      </div>
      <button
        onClick={toggle}
        disabled={busy}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
          blanked
            ? "bg-red-500 text-white hover:bg-red-600"
            : "bg-board-bg text-board-muted hover:text-board-text border border-board-border"
        }`}
      >
        {blanked ? "Restore" : "Blank"}
      </button>
    </div>
  );
}

// ─── Access Tokens ───────────────────────────────────────────

type KioskTokenRow = {
  id: string;
  label: string;
  expiresAt: string | Date | null;
  createdAt: string | Date;
};

function AccessTokensTab({ orgId, slug }: { orgId: string; slug: string }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ id: string; label: string; token: string } | null>(null);
  const [removal, setRemoval] = useState<KioskTokenRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readTokens = useCallback((signal: AbortSignal) => listKioskTokens({ data: { orgId }, signal }), [orgId]);
  const tokenRead = useOperatorRead<KioskTokenRow[] | null>({
    key: orgId, initialValue: null, read: readTokens,
    errorMessage: "Could not read kiosk tokens. Any displayed list is the last confirmed result.",
  });
  const tokens = tokenRead.value ?? [];
  const loading = tokenRead.value === null && !tokenRead.error;

  const generate = async () => {
    if (!label.trim() || busy || issuedToken) return;
    setBusy(true); setError(null);
    try {
      // view "board" — the read-only kiosk data endpoints ignore it, but the
      // schema requires a value and "board" matches the lobby/booth use case.
      const created = await createKioskToken({
        data: { orgId, label: label.trim(), view: "board", expiresInDays: null },
      });
      setLabel("");
      setIssuedToken(created);
      tokenRead.invalidate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create token."); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!removal || busy) return;
    setBusy(true); setError(null);
    try {
      await revokeKioskToken({ data: { tokenId: removal.id } });
      if (issuedToken?.id === removal.id) setIssuedToken(null);
      tokenRead.invalidate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke token."); }
    finally { setBusy(false); setRemoval(null); }
  };

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      {issuedToken && <CreatedTokenNotice key={issuedToken.id} label={issuedToken.label} token={issuedToken.token} onDismiss={() => setIssuedToken(null)} />}
      <ConfirmDialog open={removal !== null} onOpenChange={open => { if (!open && !busy) setRemoval(null); }} title={`Revoke ${removal?.label ?? "this token"}?`} description="Devices using this token will lose access. Generate a replacement before revoking a token still in use." confirmLabel="Revoke token" loading={busy} onConfirm={() => { void revoke(); }} />
      <div className="rounded-xl border border-board-border bg-board-card p-3">
        <div className="flex items-center gap-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generate()}
            aria-label="Token label"
            placeholder="Token label (e.g. Lobby rotator)"
            className="min-w-0 min-h-11 flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500"
          />
          <button
            onClick={generate}
            disabled={busy || !label.trim() || issuedToken !== null}
            className="min-h-11 shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Generate
          </button>
        </div>
        <p className="mt-2 text-[11px] text-board-muted/70">
          Send as <code className="text-board-muted">Authorization: Bearer &lt;token&gt;</code> to{" "}
          <code className="text-board-muted">/api/v1/kiosk/*</code> for org{" "}
          <span className="font-mono">{slug}</span>. Copy it now — store it somewhere safe.
        </p>
      </div>

      <ReadFailureNotice error={tokenRead.error} refreshing={tokenRead.refreshing} retry={tokenRead.retry} label="Retry kiosk tokens" />
      {loading ? (
        <div className="py-10 text-center text-sm text-board-muted">Loading…</div>
      ) : tokenRead.value === null ? null : tokens.length === 0 ? (
        <div className="text-center py-10 text-sm text-board-muted">
          No tokens yet — generate one above for your kiosk displays.
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((row) => {
            return (
              <div
                key={row.id}
                className="flex items-center gap-2 rounded-xl border border-board-border bg-board-card p-3"
              >
                <KeyRound className="w-4 h-4 text-board-muted shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-board-text truncate">{row.label}</div>
                  <code className="text-[11px] text-board-muted font-mono break-all">
                    Token saved. Its value cannot be shown again.
                  </code>
                </div>
                <button
                  onClick={() => setRemoval(row)}
                  disabled={busy}
                  title="Revoke token"
                  className="min-h-11 min-w-11 flex items-center justify-center p-2 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Org Chart ───────────────────────────────────────────────

function OrgChartTab({
  orgId,
  teams,
  members,
  onChange,
}: {
  orgId: string;
  teams: AdminTeam[];
  members: Member[];
  onChange: () => void;
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TEAM_COLORS[0]);
  const [busy, setBusy] = useState(false);

  const addTeam = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    await createTeam({ data: { orgId, name: newName.trim(), color: newColor } });
    setNewName("");
    setBusy(false);
    onChange();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-xl border border-board-border bg-board-card p-3">
        <div className="flex items-center gap-1">
          {TEAM_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setNewColor(c)}
              className="w-5 h-5 rounded-full border-2"
              style={{ background: c, borderColor: newColor === c ? "white" : "transparent" }}
            />
          ))}
        </div>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addTeam()}
          placeholder="New team name (e.g. Audio)"
          className="flex-1 px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500"
        />
        <button
          onClick={addTeam}
          disabled={busy || !newName.trim()}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" /> Add Team
        </button>
      </div>

      {teams.length === 0 ? (
        <div className="text-center py-10 text-sm text-board-muted">
          No teams yet — add one above to build the org chart.
        </div>
      ) : (
        teams.map((team) => (
          <TeamCard key={team.id} orgId={orgId} team={team} members={members} onChange={onChange} />
        ))
      )}
    </div>
  );
}

function TeamCard({
  orgId,
  team,
  members,
  onChange,
}: {
  orgId: string;
  team: AdminTeam;
  members: Member[];
  onChange: () => void;
}) {
  const memberIds = new Set(team.members.map((m) => m.userId));
  const available = members.filter((m) => !memberIds.has(m.id));

  const rename = async (name: string) => {
    if (name.trim() && name.trim() !== team.name) {
      await updateTeam({ data: { orgId, id: team.id, name: name.trim(), color: team.color } });
      onChange();
    }
  };
  const recolor = async (color: string) => {
    await updateTeam({ data: { orgId, id: team.id, name: team.name, color } });
    onChange();
  };
  const addMember = async (userId: string) => {
    if (!userId) return;
    await setTeamMember({ data: { orgId, teamId: team.id, userId, role: "member" } });
    onChange();
  };
  const toggleLead = async (userId: string, isLead: boolean) => {
    await setTeamMember({ data: { orgId, teamId: team.id, userId, role: isLead ? "member" : "lead" } });
    onChange();
  };
  const remove = async (userId: string) => {
    await removeTeamMember({ data: { orgId, teamId: team.id, userId } });
    onChange();
  };

  return (
    <div className="rounded-xl border border-board-border bg-board-card p-4" style={{ borderLeft: `3px solid ${team.color}` }}>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex items-center gap-1">
          {TEAM_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => recolor(c)}
              className="w-4 h-4 rounded-full border-2"
              style={{ background: c, borderColor: team.color === c ? "white" : "transparent" }}
            />
          ))}
        </div>
        <input
          key={team.name}
          defaultValue={team.name}
          onBlur={(e) => rename(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="flex-1 bg-transparent text-sm font-semibold text-board-text focus:outline-none focus:border-b focus:border-fire-500"
        />
        <button
          onClick={() => deleteTeam({ data: { orgId, id: team.id } }).then(onChange)}
          className="p-1.5 rounded-lg text-board-muted hover:text-red-400 hover:bg-red-500/10"
          title="Delete team"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1.5">
        {team.members.map((m) => {
          const isLead = m.role === "lead";
          return (
            <div key={m.userId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-board-bg">
              <span className="text-sm text-board-text flex-1 truncate">{m.name}</span>
              <button
                onClick={() => toggleLead(m.userId, isLead)}
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide transition-colors ${
                  isLead
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/25"
                    : "text-board-muted border border-board-border hover:text-board-text"
                }`}
                title={isLead ? "Lead — click to make member" : "Make lead"}
              >
                <Crown className="w-2.5 h-2.5" />
                {isLead ? "Lead" : "Member"}
              </button>
              <button
                type="button"
                onClick={() => remove(m.userId)}
                aria-label={`Remove ${m.name} from kiosk team`}
                title={`Remove ${m.name} from kiosk team`}
                className="p-1 rounded text-board-muted hover:text-red-400"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {available.length > 0 && (
        <select
          value=""
          onChange={(e) => addMember(e.target.value)}
          className="mt-2 w-full px-3 py-2 rounded-lg bg-board-bg border border-board-border text-xs text-board-muted focus:outline-none focus:border-fire-500"
        >
          <option value="">+ Add member…</option>
          {available.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

// ─── Roster ──────────────────────────────────────────────────

function RosterTab(props: { orgId: string; roles: RosterRole[]; members: Member[]; onChange: () => void }) {
  const [week, setWeek] = useState(() => snapSunday(new Date().toISOString().slice(0, 10)));
  return <RosterWeekEditor key={`${props.orgId}:${week}`} {...props} week={week} onWeekChange={setWeek} />;
}

function RosterWeekEditor({ orgId, roles, members, onChange, week, onWeekChange }: {
  orgId: string; roles: RosterRole[]; members: Member[]; onChange: () => void;
  week: string; onWeekChange: (week: string) => void;
}) {
  const readWeek = useCallback((signal: AbortSignal) => getRosterWeek({ data: { orgId, weekStart: week }, signal }), [orgId, week]);
  const weekRead = useOperatorRead<Awaited<ReturnType<typeof getRosterWeek>> | null>({
    key: `${orgId}:${week}`, initialValue: null, read: readWeek, enabled: roles.length > 0,
    errorMessage: "Could not read this roster week. Any displayed assignments are the last confirmed result; your edits are retained.",
  });
  // Refocusing the tab can refresh saved assignments, but must never replace edits.
  const [draft, setDraft] = useState<{ tech: Record<string, string>; pm: string } | null>(null);
  const tech = draft?.tech ?? weekRead.value?.tech ?? {};
  const pm = draft?.pm ?? weekRead.value?.pmUserId ?? "";
  const loading = weekRead.value === null && !weekRead.error;
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const save = async () => {
    setSaving(true);
    await saveRosterWeek({
      data: {
        orgId,
        weekStart: week,
        tech: Object.entries(tech)
          .filter(([, userId]) => userId)
          .map(([roleId, userId]) => ({ roleId, userId })),
        pmUserId: pm || null,
      },
    });
    setSaving(false);
    setSavedMsg("Week saved");
    setTimeout(() => setSavedMsg(""), 2000);
  };

  const [showRoles, setShowRoles] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newShort, setNewShort] = useState("");

  if (roles.length === 0) {
    return (
      <div className="text-center py-10 space-y-3">
        <p className="text-sm text-board-muted">No roster roles defined yet.</p>
        <button
          onClick={() => seedRosterRoles({ data: { orgId } }).then(onChange)}
          className="px-4 py-2 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600"
        >
          Add default roles (TM, Audio, Cam 1/2, Pro, Stream)
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-board-border bg-board-card p-3">
        <CalendarDays className="w-4 h-4 text-board-muted" />
        <label className="text-xs text-board-muted">Week starting (Sun)</label>
        <input
          type="date"
          value={week}
          aria-label="Roster week starting Sunday"
          onChange={(e) => { if (e.target.value) onWeekChange(snapSunday(e.target.value)); }}
          className="px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text focus:outline-none focus:border-fire-500"
        />
        <div className="ml-auto flex items-center gap-2">
          {savedMsg && <span className="text-xs text-green-400">{savedMsg}</span>}
          <button
            onClick={save}
            disabled={saving || !weekRead.value || weekRead.error !== null}
            className="px-4 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Week"}
          </button>
        </div>
      </div>

      <ReadFailureNotice error={weekRead.error} refreshing={weekRead.refreshing} retry={weekRead.retry} label="Retry roster week" />
      {loading && <p className="py-6 text-center text-sm text-board-muted">Loading roster week…</p>}
      {weekRead.value !== null && <div className="rounded-xl border border-board-border bg-board-card divide-y divide-board-border/60">
        {roles.map((role) => (
          <div key={role.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-24 shrink-0 text-xs font-medium text-board-text">{role.short}</span>
            <span className="hidden sm:block flex-1 text-xs text-board-muted truncate">{role.name}</span>
            <select
              value={tech[role.id] ?? ""}
              aria-label={`${role.name} assignment`}
              onChange={(e) => setDraft({ pm, tech: { ...tech, [role.id]: e.target.value } })}
              className="min-h-11 min-w-0 flex-1 px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500"
            >
              <option value="">— Unassigned —</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-board-bg/40">
          <span className="w-24 shrink-0 text-xs font-medium text-fire-500">PM</span>
          <span className="hidden sm:block flex-1 text-xs text-board-muted truncate">Production Manager (week)</span>
          <select
            value={pm}
            aria-label="Production Manager assignment"
            onChange={(e) => setDraft({ tech, pm: e.target.value })}
            className="min-h-11 min-w-0 flex-1 px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500"
          >
            <option value="">— Unassigned —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>}

      <div className="rounded-xl border border-board-border bg-board-card/50 p-3">
        <button
          onClick={() => setShowRoles((v) => !v)}
          className="text-[10px] font-semibold uppercase tracking-widest text-board-muted hover:text-board-text"
        >
          {showRoles ? "▾" : "▸"} Manage roles ({roles.length})
        </button>
        {showRoles && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {roles.map((r) => (
                <span key={r.id} className="flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-lg bg-board-bg border border-board-border text-xs text-board-text">
                  {r.short}
                  <button
                    type="button"
                    onClick={() => deleteRosterRole({ data: { orgId, id: r.id } }).then(onChange)}
                    aria-label={`Delete ${r.short} roster role`}
                    title={`Delete ${r.short} roster role`}
                    className="p-0.5 rounded text-board-muted hover:text-red-400"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="code" className="w-24 px-2 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500" />
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" className="flex-1 px-2 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500" />
              <input value={newShort} onChange={(e) => setNewShort(e.target.value)} placeholder="Short" className="w-24 px-2 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500" />
              <button
                onClick={async () => {
                  if (!newCode.trim()) return;
                  await createRosterRole({ data: { orgId, code: newCode, name: newName, short: newShort } });
                  setNewCode(""); setNewName(""); setNewShort("");
                  onChange();
                }}
                className="px-3 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600"
              >
                Add
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
