import { useState } from "react";
import { LogIn, LogOut, Search, X } from "lucide-react";
import type { CrewAttendanceMember } from "@/lib/crew-attendance-writes";
const actionClass = "min-h-11 rounded-xl border border-board-border px-3 py-2 text-sm font-medium disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fire-500";
export function CheckInList({ members, blocked, refreshing, onChange, onSetAll }: {
  members: CrewAttendanceMember[];
  blocked: boolean;
  refreshing: boolean;
  onChange: (member: CrewAttendanceMember) => void;
  onSetAll: (isOnline: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const filtered = members.filter(member => !term || `${member.name} ${member.role} ${member.memberId}`.toLowerCase().includes(term));
  const online = members.filter(member => member.isOnline).length;
  return <div className="space-y-4">
    <p className="text-sm text-board-muted">{online} checked in · {members.length - online} checked out</p>
    {members.length > 0 && <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={blocked || online === members.length} onClick={() => onSetAll(true)} className={`${actionClass} flex items-center gap-2 text-green-400`}><LogIn className="size-4" />Check all {members.length} crew in</button>
      <button type="button" disabled={blocked || online === 0} onClick={() => onSetAll(false)} className={`${actionClass} flex items-center gap-2`}><LogOut className="size-4" />Check all {members.length} crew out</button>
      {term && <p className="w-full text-xs text-board-muted">Bulk actions include all {members.length} crew, including people outside this search.</p>}
    </div>}
    <label htmlFor="crew-checkin-search" className="block text-sm font-medium">Search crew</label>
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-board-muted" />
      <input id="crew-checkin-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, role or member ID" className="min-h-11 w-full rounded-xl border border-board-border bg-board-card py-3 pl-10 pr-12 text-sm focus-visible:outline-fire-500" />
      {search && <button type="button" onClick={() => setSearch("")} aria-label="Clear crew search" className="absolute inset-y-0 right-0 flex min-w-11 items-center justify-center rounded-xl focus-visible:outline-fire-500"><X className="size-4" /></button>}
    </div>
    <div className="space-y-2">{filtered.map(member => <div key={member.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-board-border bg-board-card p-3">
      {member.photoUrl ? <img src={member.photoUrl} alt="" className="size-10 shrink-0 rounded-full object-cover" /> : <div aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-board-border">{member.name.charAt(0)}</div>}
      <div className="min-w-0 flex-1 basis-28"><p className="break-words text-sm font-medium">{member.name}</p><p className="break-words text-xs text-board-muted">{member.role}</p><p className={`text-xs ${member.isOnline ? "text-green-400" : "text-board-muted"}`}>{member.isOnline ? "Checked in" : "Checked out"}</p></div>
      <button type="button" disabled={blocked} onClick={() => onChange(member)} aria-label={`Check ${member.name} ${member.isOnline ? "out" : "in"}`} className={`${actionClass} shrink-0`}>{member.isOnline ? "Check out" : "Check in"}</button>
    </div>)}</div>
    {filtered.length === 0 && (refreshing && members.length === 0 ? <p role="status">Loading crew…</p> : <p className="py-5 text-sm text-board-muted">{term ? "No crew match this search." : "No crew members yet. Ask a team admin to add crew."}</p>)}
  </div>;
}
