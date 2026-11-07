import { workspaceCopy } from "@showpilot/shared";
import { useTerms as useWorkspaceTerms } from "@/components/workspace/WorkspaceProvider";
import { useState, useMemo, useRef } from "react";
import { Pencil, Trash2, UserPlus, Users, Search, X } from "lucide-react";
import { deleteCrewMember } from "@/lib/data";
import { MemberForm, type CrewChange } from "./MemberForm";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  crewProfileResultSchema,
  type CrewRosterMember as Member,
} from "@/lib/crew-roster-contract";
import {
  DEPARTMENTS,
  getDepartment,
  type RoleDepartment,
  type DepartmentConfig,
} from "@/types";

type ViewFilter = "all" | RoleDepartment;

const DEPARTMENT_ORDER: RoleDepartment[] = [
  "leadership",
  "production",
  "camera",
  "audio",
  "visuals",
  "lighting",
  "streaming",
  "technical",
  "other",
];

function MemberCard({
  member,
  onEdit,
  onDelete,
  deleting,
  canManage,
}: {
  member: Member;
  onEdit: (m: Member) => void;
  onDelete: (m: Member) => void;
  deleting: boolean;
  canManage: boolean;
}) {
  const dept = getDepartment(member.role);
  const config = DEPARTMENTS[dept];

  return (
    <div className="group flex flex-wrap items-center gap-3 p-3 rounded-xl bg-board-card border border-board-border hover:border-fire-500/20 transition-all duration-200">
      <div className="relative w-11 h-11 rounded-full overflow-hidden bg-board-border shrink-0">
        {member.photoUrl ? (
          <img
            src={member.photoUrl}
            alt={member.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-fire-500/20 to-fire-700/20 text-fire-400 text-base font-semibold">
            {member.name.charAt(0)}
          </div>
        )}
        <div
          className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-board-card ${
            member.isOnline ? "bg-green-500" : "bg-gray-500"
          }`}
        />
      </div>

      <div className="flex-1 min-w-24">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sm text-board-text break-words">
            {member.name}
          </p>
          {member.memberId && (
            <span className="text-xs font-mono text-board-muted bg-board-bg px-1.5 py-0.5 rounded border border-board-border tracking-wider">
              {member.memberId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            className={`text-xs font-medium uppercase tracking-wider px-1.5 py-0.5 rounded border ${config.color}`}
          >
            {member.role}
          </span>
        </div>
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={deleting}
            onClick={() => onEdit(member)}
            aria-label={`Edit ${member.name}`}
            title={`Edit ${member.name}`}
            className="min-h-11 min-w-11 flex items-center justify-center p-2 rounded-lg disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-fire-500 hover:bg-board-border transition-colors text-board-muted hover:text-board-text"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(member)}
            aria-label={`Remove ${member.name}`}
            title={`Remove ${member.name}`}
            disabled={deleting}
            className="min-h-11 min-w-11 flex items-center justify-center p-2 rounded-lg disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-fire-500 hover:bg-red-500/20 transition-colors text-board-muted hover:text-red-400 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  onAdd,
  canManage,
}: {
  onAdd: () => void;
  canManage: boolean;
}) {
  const workspaceTerms = useWorkspaceTerms();
  return (
    <div className="flex flex-col items-center py-20">
      <div className="relative mb-8">
        <div className="absolute inset-0 rounded-full bg-fire-500/10 blur-2xl scale-150" />
        <div className="relative w-24 h-24 rounded-2xl bg-gradient-to-br from-fire-500/20 to-fire-800/10 border border-fire-500/20 flex items-center justify-center">
          <Users className="w-10 h-10 text-fire-500/60" />
        </div>
        <div className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-fire-500/20 border border-fire-500/30" />
        <div className="absolute -bottom-1 -left-3 w-3 h-3 rounded-full bg-fire-500/15 border border-fire-500/20" />
      </div>

      <h2 className="text-xl font-semibold font-[family-name:var(--font-display)] text-board-text mb-2">
        Build your production team
      </h2>
      <p className="text-board-muted text-sm text-center max-w-xs mb-8 leading-relaxed">
        Add the people who run your show — sound techs, camera ops, stage
        managers, and everyone in between.
      </p>

      {canManage ? (
        <button
          onClick={onAdd}
          className="flex items-center gap-2.5 px-6 py-3 rounded-xl font-[family-name:var(--font-display)] font-semibold text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
          style={{
            background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
          }}
        >
          <UserPlus className="w-5 h-5" />
          Add your first crew member
        </button>
      ) : null}

      <div className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-lg">
        {[
          { step: "1", title: "Add members", desc: "Name, role, and a photo" },
          { step: "2", title: "They check in", desc: "Scan a badge or tap in" },
          {
            step: "3",
            title: "Go live",
            desc: workspaceCopy(
              "See who's serving in real time",
              workspaceTerms,
            ),
          },
        ].map((item) => (
          <div
            key={item.step}
            className="flex items-start gap-3 p-3 rounded-xl border border-board-border/60 bg-board-card/50"
          >
            <span className="shrink-0 w-6 h-6 rounded-full bg-fire-500/15 text-fire-500 text-xs font-bold flex items-center justify-center">
              {item.step}
            </span>
            <div>
              <p className="text-xs font-medium text-board-text">
                {item.title}
              </p>
              <p className="text-sm text-board-muted">{item.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface MemberTableProps {
  members: Member[];
  orgId: string;
  canManage: boolean;
  disabled: boolean;
  change: (change: CrewChange) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function MemberTable({
  members,
  orgId,
  canManage,
  disabled,
  change,
  onDirtyChange,
}: MemberTableProps) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const openForm = () => {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setShowForm(true);
  };
  const restoreFocus = () => {
    const target = returnFocus.current;
    if (target?.isConnected && !target.matches(":disabled")) target.focus();
    else root.current?.focus();
  };
  const [showForm, setShowForm] = useState(false);
  const [editor, setEditor] = useState<{ member: Member | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const saved = () => {
    setEditor(null);
    setShowForm(false);
    setDirty(false);
    onDirtyChange(false);
  };
  const discard = async () => {
    if (disabled) return false;
    if (
      dirty &&
      !(await confirm({
        title: "Discard crew draft?",
        description: "Your unsaved crew profile changes will be lost.",
        confirmLabel: "Discard draft",
        cancelLabel: "Keep draft",
      }))
    )
      return false;
    saved();
    return true;
  };
  const [activeFilter, setActiveFilter] = useState<ViewFilter>("all");
  const [search, setSearch] = useState("");
  const { confirm, ConfirmDialogEl } = useConfirmDialog();

  const grouped = useMemo(() => {
    const groups: Record<RoleDepartment, Member[]> = {
      leadership: [],
      production: [],
      camera: [],
      audio: [],
      visuals: [],
      lighting: [],
      streaming: [],
      technical: [],
      other: [],
    };
    members.forEach((m) => {
      const dept = getDepartment(m.role);
      groups[dept].push(m);
    });
    return groups;
  }, [members]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: members.length };
    DEPARTMENT_ORDER.forEach((dept) => {
      c[dept] = grouped[dept].length;
    });
    return c;
  }, [members, grouped]);

  const filteredMembers = useMemo(() => {
    let list = activeFilter === "all" ? members : grouped[activeFilter] || [];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.role.toLowerCase().includes(q) ||
          m.memberId?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [activeFilter, members, grouped, search]);

  const handleDelete = async (member: Member) => {
    if (
      disabled ||
      !(await confirm({
        title: "Remove crew member?",
        description: `Remove ${member.name} from the roster and clear their scheduled assignments? Their account access is unchanged. This cannot be undone.`,
        confirmLabel: "Remove crew member",
      }))
    )
      return;
    change({
      label: `Remove crew member ${member.name}`,
      write: async (requestId, signal) =>
        crewProfileResultSchema.parse(
          await deleteCrewMember({
            data: {
              orgId,
              id: member.id,
              expectedRevision: member.profileRevision,
              requestId,
            },
            signal,
          }),
        ),
    });
  };
  const beginEditor = async (member: Member | null) => {
    if (disabled) return;
    if (editor && editor.member?.id !== member?.id && !(await discard()))
      return;
    if (!editor || editor.member?.id !== member?.id) setEditor({ member });
    openForm();
  };
  const handleEdit = (member: Member) => void beginEditor(member);
  const handleAdd = () => void beginEditor(null);

  const filterTabs: {
    key: ViewFilter;
    label: string;
    config?: DepartmentConfig;
  }[] = [
    { key: "all", label: "All" },
    ...DEPARTMENT_ORDER.filter((dept) => counts[dept] > 0).map((dept) => ({
      key: dept as ViewFilter,
      label: DEPARTMENTS[dept].label,
      config: DEPARTMENTS[dept],
    })),
  ];

  const onlineCount = members.filter((m) => m.isOnline).length;

  return (
    <div ref={root} tabIndex={-1}>
      {editor && !showForm && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-board-border p-3">
          <p className="text-sm text-board-text">
            Crew draft: {editor.member?.name || "New crew member"}
          </p>
          <button
            type="button"
            onClick={openForm}
            className="min-h-11 min-w-11 rounded-lg border border-board-border px-3 text-sm text-board-text focus-visible:ring-2 focus-visible:ring-fire-500"
          >
            Resume draft
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void discard()}
            className="min-h-11 min-w-11 rounded-lg border border-board-border px-3 text-sm text-board-text disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-fire-500"
          >
            Discard draft
          </button>
        </div>
      )}
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold font-[family-name:var(--font-display)] text-board-text">
            Crew roster
          </h1>
          {members.length > 0 && (
            <p className="text-board-muted text-sm mt-1 flex items-center gap-2">
              <span>
                {members.length} member{members.length !== 1 ? "s" : ""}
              </span>
              <span className="text-board-border">&middot;</span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                {onlineCount} online
              </span>
            </p>
          )}
        </div>
        {canManage && members.length > 0 && (
          <button
            onClick={handleAdd}
            disabled={disabled}
            className="min-h-11 min-w-11 focus-visible:ring-2 focus-visible:ring-fire-500 flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98]"
            style={{
              background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
            }}
          >
            <UserPlus className="w-4 h-4" />
            Add crew member
          </button>
        )}
      </div>

      {members.length === 0 ? (
        <EmptyState onAdd={handleAdd} canManage={canManage && !disabled} />
      ) : (
        <>
          {/* Search + filters */}
          <div className="space-y-3 mb-5">
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-board-muted pointer-events-none" />
              <input
                type="text"
                aria-label="Search crew by name, role, or badge ID"
                placeholder="Search by name, role, or ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-board-card border border-board-border text-sm text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear crew search"
                  title="Clear crew search"
                  className="absolute right-1 top-1/2 -translate-y-1/2 min-h-11 min-w-11 flex items-center justify-center rounded-md hover:bg-board-border transition-colors text-board-muted"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar pb-1">
              {filterTabs.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveFilter(tab.key)}
                  aria-pressed={activeFilter === tab.key}
                  className={`min-h-11 min-w-11 focus-visible:ring-2 focus-visible:ring-fire-500 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all duration-150 ${
                    activeFilter === tab.key
                      ? "bg-fire-500/15 text-fire-500 border border-fire-500/25"
                      : "text-board-muted hover:text-board-text hover:bg-board-border/50 border border-transparent"
                  }`}
                >
                  {tab.label}
                  <span
                    className={`text-xs tabular-nums px-1.5 py-0.5 rounded-full ${
                      activeFilter === tab.key
                        ? "bg-fire-500/20 text-fire-400"
                        : "bg-board-border text-board-muted"
                    }`}
                  >
                    {counts[tab.key]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Members list */}
          {search && filteredMembers.length === 0 ? (
            <div className="text-center py-12">
              <Search className="w-8 h-8 text-board-muted/30 mx-auto mb-3" />
              <p className="text-sm text-board-muted">
                No members matching &ldquo;{search}&rdquo;
              </p>
            </div>
          ) : activeFilter === "all" && !search ? (
            <div className="space-y-6">
              {DEPARTMENT_ORDER.map((dept) => {
                const deptMembers = grouped[dept];
                if (deptMembers.length === 0) return null;
                const config = DEPARTMENTS[dept];
                return (
                  <div key={dept}>
                    <div className="flex items-center gap-2 mb-2 pl-1">
                      <span
                        className={`text-xs font-medium uppercase tracking-widest px-2 py-0.5 rounded-md border ${config.color}`}
                      >
                        {config.label}
                      </span>
                      <span className="text-xs text-board-muted tabular-nums">
                        {deptMembers.length}
                      </span>
                    </div>
                    <div className="grid gap-2">
                      {deptMembers.map((member) => (
                        <MemberCard
                          key={member.id}
                          member={member}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          deleting={disabled}
                          canManage={canManage}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid gap-2">
              {filteredMembers.map((member) => (
                <MemberCard
                  key={member.id}
                  member={member}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  deleting={disabled}
                  canManage={canManage}
                />
              ))}
            </div>
          )}
        </>
      )}

      {canManage && editor && (
        <MemberForm
          key={editor.member?.id ?? "new-crew"}
          orgId={orgId}
          member={editor.member}
          open={showForm}
          restoreFocus={restoreFocus}
          disabled={disabled}
          change={change}
          onDirtyChange={(value) => {
            setDirty(value);
            onDirtyChange(value);
          }}
          onClose={() => setShowForm(false)}
          onSaved={saved}
        />
      )}
      {ConfirmDialogEl}
    </div>
  );
}
