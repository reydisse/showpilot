import { useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Check, ChevronDown, Clock3, KeyRound, ShieldCheck, X } from "lucide-react";
import { ACCESS_CAPABILITIES, getAccessCapability } from "@/lib/access-capabilities";
import { grantMemberAccess, revokeMemberAccess } from "@/lib/access-grants";
import { ROLE_META } from "@/lib/permissions";

interface AccessMember {
  userId: string;
  role: string;
  user: { name: string; email: string; image: string | null };
}

interface ActiveGrant {
  id: string;
  userId: string;
  capability: string;
  permissions: string;
  startsOn: string;
  expiresOn: string | null;
  reason: string;
  grantedByUserId: string;
  createdAt: string | Date;
  grantedBy: { name: string };
  canRevoke: boolean;
}

interface AccessAuthority {
  canManage: boolean;
  kind: "permanent" | "on-duty-tm" | "none";
  weekStart: string;
  weekEndExclusive: string;
  today: string;
}

function formatDate(value: string) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function dutyWeekLabel(authority: AccessAuthority) {
  const end = new Date(`${authority.weekEndExclusive}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return `${formatDate(authority.weekStart)} – ${formatDate(end.toISOString().slice(0, 10))}`;
}

function grantEndLabel(expiresOn: string) {
  const end = new Date(`${expiresOn}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return formatDate(end.toISOString().slice(0, 10));
}

export function AccessManagementTab({
  orgId,
  currentUserId,
  authority,
  members,
  grants,
}: {
  orgId: string;
  currentUserId: string;
  authority: AccessAuthority;
  members: AccessMember[];
  grants: ActiveGrant[];
}) {
  const router = useRouter();
  const eligibleMembers = useMemo(
    () => members.filter((member) => member.userId !== currentUserId),
    [currentUserId, members],
  );
  const [showGrantForm, setShowGrantForm] = useState(false);
  const [userId, setUserId] = useState(eligibleMembers[0]?.userId ?? "");
  const [capability, setCapability] = useState(ACCESS_CAPABILITIES[0].id);
  const [duration, setDuration] = useState<"this-week" | "until-revoked">("this-week");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const grantsByMember = useMemo(() => {
    const grouped = new Map<string, ActiveGrant[]>();
    for (const grant of grants) {
      const current = grouped.get(grant.userId) ?? [];
      current.push(grant);
      grouped.set(grant.userId, current);
    }
    return grouped;
  }, [grants]);

  const resetForm = () => {
    setShowGrantForm(false);
    setCapability(ACCESS_CAPABILITIES[0].id);
    setDuration("this-week");
    setReason("");
    setError("");
  };

  const submitGrant = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userId) return;
    setSaving(true);
    setError("");
    try {
      await grantMemberAccess({
        data: { orgId, userId, capability, duration, reason },
      });
      resetForm();
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to grant access.");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (grant: ActiveGrant) => {
    setRevokingId(grant.id);
    setError("");
    try {
      await revokeMemberAccess({ data: { orgId, grantId: grant.id } });
      await router.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to revoke access.");
    } finally {
      setRevokingId(null);
    }
  };

  if (!authority.canManage) return null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-300">
            {authority.kind === "permanent" ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <Clock3 className="h-4 w-4" />
            )}
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-board-text">
              {authority.kind === "permanent" ? "Permanent access authority" : "On-duty TM authority"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-board-muted">
              {authority.kind === "permanent"
                ? "Owners and Admins can grant weekly or ongoing operational access at any time."
                : `You can grant and revoke operational access for this duty week: ${dutyWeekLabel(authority)}.`}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      {showGrantForm ? (
        <form onSubmit={submitGrant} className="space-y-4 rounded-xl border border-board-border bg-board-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-board-text">Grant operational access</h3>
              <p className="mt-0.5 text-xs text-board-muted">The member keeps their base role.</p>
            </div>
            <button type="button" onClick={resetForm} className="rounded-lg p-2 text-board-muted hover:bg-board-border hover:text-board-text" aria-label="Close grant form">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-board-muted">
              Member
              <span className="relative block">
                <select value={userId} onChange={(event) => setUserId(event.target.value)} className="w-full appearance-none rounded-lg border border-board-border bg-board-bg px-3 py-2.5 pr-9 text-sm text-board-text outline-none focus:border-fire-500/50">
                  {eligibleMembers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.user.name} · {ROLE_META[member.role as keyof typeof ROLE_META]?.label ?? member.role}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-board-muted" />
              </span>
            </label>

            <label className="space-y-1.5 text-xs font-medium text-board-muted">
              Capability
              <span className="relative block">
                <select value={capability} onChange={(event) => setCapability(event.target.value as typeof capability)} className="w-full appearance-none rounded-lg border border-board-border bg-board-bg px-3 py-2.5 pr-9 text-sm text-board-text outline-none focus:border-fire-500/50">
                  {ACCESS_CAPABILITIES.map((item) => (
                    <option key={item.id} value={item.id}>{item.label}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-board-muted" />
              </span>
            </label>
          </div>

          <p className="rounded-lg bg-board-bg px-3 py-2 text-xs leading-relaxed text-board-muted">
            {getAccessCapability(capability)?.description}
          </p>

          {authority.kind === "permanent" ? (
            <fieldset className="space-y-2">
              <legend className="text-xs font-medium text-board-muted">Duration</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {([
                  ["this-week", `This week · ${dutyWeekLabel(authority)}`],
                  ["until-revoked", "Until manually revoked"],
                ] as const).map(([value, label]) => (
                  <label key={value} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs ${duration === value ? "border-fire-500/45 bg-fire-500/10 text-board-text" : "border-board-border text-board-muted"}`}>
                    <input type="radio" name="duration" value={value} checked={duration === value} onChange={() => setDuration(value)} className="accent-amber-500" />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <label className="block space-y-1.5 text-xs font-medium text-board-muted">
            Reason <span className="font-normal text-board-muted/60">(optional)</span>
            <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={240} placeholder="e.g. Covering rundown for Sunday service" className="w-full rounded-lg border border-board-border bg-board-bg px-3 py-2.5 text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50" />
          </label>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={resetForm} className="min-h-[42px] rounded-lg px-4 text-xs font-medium text-board-muted hover:bg-board-border/50 hover:text-board-text">Cancel</button>
            <button type="submit" disabled={saving || !userId} className="min-h-[42px] rounded-lg bg-gradient-to-br from-amber-400 to-amber-600 px-4 text-xs font-semibold text-black disabled:opacity-50">
              {saving ? "Granting…" : "Grant access"}
            </button>
          </div>
        </form>
      ) : (
        <button onClick={() => setShowGrantForm(true)} disabled={eligibleMembers.length === 0} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 px-4 text-sm font-semibold text-black transition hover:shadow-lg hover:shadow-amber-500/20 disabled:opacity-50">
          <KeyRound className="h-4 w-4" />
          Grant access
        </button>
      )}

      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-xs font-medium uppercase tracking-widest text-board-muted">Active grants</h3>
          <span className="text-xs tabular-nums text-board-muted">{grants.length}</span>
        </div>

        <div className="space-y-3">
          {members.map((member) => {
            const memberGrants = grantsByMember.get(member.userId) ?? [];
            if (memberGrants.length === 0) return null;
            return (
              <div key={member.userId} className="rounded-xl border border-board-border bg-board-card p-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-board-border text-sm font-semibold text-fire-400">
                    {member.user.image ? <img src={member.user.image} alt="" className="h-full w-full object-cover" /> : member.user.name.charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-board-text">{member.user.name}</p>
                    <p className="truncate text-xs text-board-muted">{member.user.email}</p>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {memberGrants.map((grant) => {
                    const definition = getAccessCapability(grant.capability);
                    return (
                      <div key={grant.id} className="flex flex-col gap-2 rounded-lg border border-board-border/70 bg-board-bg/60 px-3 py-2.5 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                            <p className="truncate text-xs font-medium text-board-text">{definition?.label ?? grant.capability}</p>
                          </div>
                          <p className="mt-1 text-[11px] text-board-muted">
                            {grant.expiresOn ? `Active through ${grantEndLabel(grant.expiresOn)}` : "Active until revoked"} · granted by {grant.grantedBy.name}
                          </p>
                          {grant.reason ? <p className="mt-1 break-words text-[11px] text-board-muted/80">{grant.reason}</p> : null}
                        </div>
                        {grant.canRevoke ? (
                          <button onClick={() => void revoke(grant)} disabled={revokingId === grant.id} className="min-h-[40px] shrink-0 rounded-lg border border-red-500/20 px-3 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                            {revokingId === grant.id ? "Revoking…" : "Revoke"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {grants.length === 0 ? (
            <div className="rounded-xl border border-dashed border-board-border px-4 py-10 text-center">
              <KeyRound className="mx-auto h-6 w-6 text-board-muted/50" />
              <p className="mt-3 text-sm font-medium text-board-text">No custom access is active</p>
              <p className="mt-1 text-xs text-board-muted">Members are using only their normal role permissions.</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
