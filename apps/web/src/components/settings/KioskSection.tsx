import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Crown, X, Users, CalendarDays } from "lucide-react";
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

  const [tab, setTab] = useState<"org" | "roster">("org");
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [roles, setRoles] = useState<RosterRole[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [t, r] = await Promise.all([
      getKioskTeams({ data: { orgId } }),
      getRosterRoles({ data: { orgId } }),
    ]);
    setTeams(t);
    setRoles(r);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    reload();
  }, [reload]);

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

      <div className="flex items-center gap-1.5 mb-5">
        {[
          { id: "org" as const, label: "Org Chart", icon: Users },
          { id: "roster" as const, label: "On-Duty Roster", icon: CalendarDays },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
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

      {loading ? (
        <div className="py-10 text-center text-sm text-board-muted">Loading…</div>
      ) : tab === "org" ? (
        <OrgChartTab orgId={orgId} teams={teams} members={members} onChange={reload} />
      ) : (
        <RosterTab orgId={orgId} roles={roles} members={members} onChange={reload} />
      )}

      <p className="mt-8 text-[10px] text-board-muted/50">
        Live at <code className="text-board-muted">/api/v1/kiosk/org</code> and{" "}
        <code className="text-board-muted">/api/v1/kiosk/roster</code> for org{" "}
        <span className="font-mono">{slug}</span> (kiosk token required).
      </p>
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
                onClick={() => remove(m.userId)}
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

function RosterTab({
  orgId,
  roles,
  members,
  onChange,
}: {
  orgId: string;
  roles: RosterRole[];
  members: Member[];
  onChange: () => void;
}) {
  const [week, setWeek] = useState<string>(() => snapSunday(new Date().toISOString().slice(0, 10)));
  const [tech, setTech] = useState<Record<string, string>>({});
  const [pm, setPm] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const loadWeek = useCallback(
    async (w: string) => {
      setLoading(true);
      const data = await getRosterWeek({ data: { orgId, weekStart: w } });
      setTech(data.tech);
      setPm(data.pmUserId ?? "");
      setLoading(false);
    },
    [orgId],
  );

  useEffect(() => {
    loadWeek(week);
  }, [week, loadWeek]);

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
      <div className="flex items-center gap-3 rounded-xl border border-board-border bg-board-card p-3">
        <CalendarDays className="w-4 h-4 text-board-muted" />
        <label className="text-xs text-board-muted">Week starting (Sun)</label>
        <input
          type="date"
          value={week}
          onChange={(e) => setWeek(snapSunday(e.target.value))}
          className="px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-sm text-board-text focus:outline-none focus:border-fire-500"
        />
        <div className="ml-auto flex items-center gap-2">
          {savedMsg && <span className="text-xs text-green-400">{savedMsg}</span>}
          <button
            onClick={save}
            disabled={saving || loading}
            className="px-4 py-1.5 rounded-lg bg-fire-500 text-white text-xs font-medium hover:bg-fire-600 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save Week"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-board-border bg-board-card divide-y divide-board-border/60">
        {roles.map((role) => (
          <div key={role.id} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-24 shrink-0 text-xs font-medium text-board-text">{role.short}</span>
            <span className="hidden sm:block flex-1 text-xs text-board-muted truncate">{role.name}</span>
            <select
              value={tech[role.id] ?? ""}
              onChange={(e) => setTech((t) => ({ ...t, [role.id]: e.target.value }))}
              className="w-48 px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500"
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
            onChange={(e) => setPm(e.target.value)}
            className="w-48 px-3 py-1.5 rounded-lg bg-board-bg border border-board-border text-xs text-board-text focus:outline-none focus:border-fire-500"
          >
            <option value="">— Unassigned —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>

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
                    onClick={() => deleteRosterRole({ data: { orgId, id: r.id } }).then(onChange)}
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
