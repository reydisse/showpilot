import { useState } from "react";
import { Search, X } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { toggleCheckIn } from "@/lib/data";
import type { Member } from "@/types";

interface CheckInListProps {
  members: Member[];
  orgId: string;
}

export function CheckInList({ members, orgId }: CheckInListProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [toggling, setToggling] = useState<string | null>(null);

  const filtered = search.trim()
    ? members.filter(
        (m) =>
          m.name.toLowerCase().includes(search.toLowerCase()) ||
          m.role.toLowerCase().includes(search.toLowerCase())
      )
    : members;

  const onlineCount = members.filter((m) => m.isOnline).length;

  const handleToggle = async (member: Member) => {
    setToggling(member.id);
    try {
      await toggleCheckIn({ data: { orgId, id: member.id, isOnline: member.isOnline } });
      router.invalidate();
    } catch {
      // silently fail
    } finally {
      setToggling(null);
    }
  };

  return (
    <div>
      {/* Summary */}
      <div className="flex items-center gap-3 mb-4 text-xs text-board-muted">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {onlineCount} online
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-gray-500" />
          {members.length - onlineCount} offline
        </span>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-board-muted pointer-events-none" />
        <input
          type="text"
          placeholder="Search members..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-9 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 transition-all"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-board-muted"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* List */}
      <div className="space-y-2">
        {filtered.map((member) => (
          <div
            key={member.id}
            className="flex items-center gap-3 p-3 rounded-xl bg-board-card border border-board-border"
          >
            <div className="relative w-10 h-10 rounded-full overflow-hidden bg-board-border shrink-0">
              {member.photoUrl ? (
                <img src={member.photoUrl} alt={member.name} className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-fire-500/20 to-fire-700/20 text-fire-400 font-semibold">
                  {member.name.charAt(0)}
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-board-text truncate">{member.name}</p>
              <p className="text-[11px] text-board-muted">{member.role}</p>
            </div>

            <button
              onClick={() => handleToggle(member)}
              disabled={toggling === member.id}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${
                member.isOnline
                  ? "bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25"
                  : "bg-board-border text-board-muted hover:bg-board-border/80"
              }`}
            >
              {member.isOnline ? "In" : "Out"}
            </button>
          </div>
        ))}

        {filtered.length === 0 && (
          <p className="text-center text-sm text-board-muted py-8">No members found</p>
        )}
      </div>
    </div>
  );
}
