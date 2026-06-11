import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { ProfileModal, ROLE_COLOURS } from "./ProfileModal";

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  pm: "Prod Mgr",
  tm: "Tech Mgr",
  sm: "Stage Mgr",
  member: "Member",
};

interface SidebarIdentityProps {
  collapsed: boolean;
  user: { id: string; name: string; email: string; image?: string | null };
  role: string;
  orgName: string;
}

export function SidebarIdentity({ collapsed, user, role, orgName }: SidebarIdentityProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [localUser, setLocalUser] = useState(user);

  const roleColour = ROLE_COLOURS[role] ?? ROLE_COLOURS.member;
  const initials = getInitials(localUser.name);
  const roleLabel = ROLE_LABELS[role] ?? role;

  const handleUserUpdated = (updates: { name?: string; image?: string }) => {
    setLocalUser((u) => ({
      ...u,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.image !== undefined ? { image: updates.image } : {}),
    }));
  };

  const avatar = (
    <div
      className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center overflow-hidden text-[9px] font-bold text-white select-none"
      style={{ backgroundColor: roleColour }}
    >
      {localUser.image ? (
        <img src={localUser.image} alt={localUser.name} className="w-full h-full object-cover" />
      ) : (
        initials
      )}
    </div>
  );

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        title="Profile"
        className={`flex items-center rounded-lg transition-colors w-full text-board-muted hover:bg-board-border/50 hover:text-board-text min-h-[44px] ${
          collapsed ? "justify-center p-2.5" : "gap-2.5 px-3 py-2.5"
        }`}
      >
        {avatar}
        {!collapsed && (
          <>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-medium text-board-text truncate leading-tight">{localUser.name}</p>
              <p className="text-[10px] text-board-muted truncate leading-tight" style={{ color: roleColour }}>
                {roleLabel}
              </p>
            </div>
            <MoreHorizontal className="w-3.5 h-3.5 shrink-0 opacity-40" />
          </>
        )}
      </button>

      <ProfileModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        user={localUser}
        role={role}
        orgName={orgName}
        onUserUpdated={handleUserUpdated}
      />
    </>
  );
}
