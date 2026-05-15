import { useState } from "react";
import { X, ChevronDown } from "lucide-react";
import { PhotoUpload } from "./PhotoUpload";
import { addCrewMember, updateCrewMember } from "@/lib/data";
import { fileToBase64 } from "@/lib/storage";
import type { Member } from "@/types";
import { DEPARTMENTS, type RoleDepartment } from "@/types";

interface MemberFormProps {
  orgId: string;
  member?: Member | null;
  onClose: () => void;
  onSaved: () => void;
}

const ROLE_GROUP_ORDER: RoleDepartment[] = [
  "leadership",
  "production",
  "camera",
  "audio",
  "visuals",
  "lighting",
  "streaming",
  "technical",
];

const CUSTOM_ROLE_VALUE = "__custom__";
const BUILT_IN_ROLES = ROLE_GROUP_ORDER.flatMap((dept) => DEPARTMENTS[dept].roles);
const BUILT_IN_ROLE_SET = new Set(BUILT_IN_ROLES);

export function MemberForm({ orgId, member, onClose, onSaved }: MemberFormProps) {
  const initialRole = member?.role || "";
  const initialUsesCustomRole = Boolean(initialRole) && !BUILT_IN_ROLE_SET.has(initialRole);
  const [memberId, setMemberId] = useState(member?.memberId || "");
  const [name, setName] = useState(member?.name || "");
  const [role, setRole] = useState(initialRole);
  const [selectedRole, setSelectedRole] = useState(
    initialUsesCustomRole ? CUSTOM_ROLE_VALUE : initialRole
  );
  const [customRole, setCustomRole] = useState(initialUsesCustomRole ? initialRole : "");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isEditing = !!member;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memberId.trim() || !name.trim() || !role.trim()) {
      setError("Member ID, name, and role are required.");
      return;
    }

    const normalizedId = memberId.trim().toUpperCase();

    setSaving(true);
    setError("");

    try {
      let photoUrl = isEditing ? member.photoUrl : "";

      if (photoFile) {
        photoUrl = await fileToBase64(photoFile);
      }

      if (isEditing) {
        await updateCrewMember({
          data: {
            orgId,
            id: member.id,
            updates: {
              memberId: normalizedId,
              name: name.trim(),
              role: role.trim(),
              photoUrl,
            },
          },
        });
      } else {
        await addCrewMember({
          data: {
            orgId,
            memberId: normalizedId,
            name: name.trim(),
            role: role.trim(),
            photoUrl,
          },
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save member.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="animate-float-in bg-board-card border border-board-border rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div>
            <h2 className="text-xl font-semibold font-[family-name:var(--font-display)] text-board-text">
              {isEditing ? "Edit Member" : "Add Member"}
            </h2>
            <p className="text-xs text-board-muted mt-0.5">
              {isEditing
                ? "Update this team member's details"
                : "Add someone to your production team"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 -mr-1 rounded-lg hover:bg-board-border transition-colors text-board-muted hover:text-board-text"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6">
          {/* Photo */}
          <div className="mb-6">
            <PhotoUpload
              currentPhotoURL={member?.photoUrl}
              onFileSelect={setPhotoFile}
            />
          </div>

          <div className="space-y-4">
            {/* Member ID */}
            <div className="group">
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500">
                Member ID
              </label>
              <input
                type="text"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value.toUpperCase())}
                placeholder="e.g. TD3917"
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 uppercase tracking-wider font-mono"
              />
              <p className="mt-1 text-[11px] text-board-muted/70">
                Used for badge scanning and quick check-in
              </p>
            </div>

            {/* Name */}
            <div className="group">
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500">
                Full Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sarah Johnson"
                className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20"
              />
            </div>

            {/* Role */}
            <div className="group">
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500">
                Role
              </label>
              <div className="relative">
                <select
                  value={selectedRole}
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    setSelectedRole(nextRole);
                    if (nextRole === CUSTOM_ROLE_VALUE) {
                      setRole(customRole.trim());
                    } else {
                      setRole(nextRole);
                    }
                  }}
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 appearance-none pr-10"
                >
                  <option value="" disabled>
                    Select a role...
                  </option>
                  {ROLE_GROUP_ORDER.map((dept) => {
                    const config = DEPARTMENTS[dept];
                    return (
                      <optgroup key={dept} label={config.label}>
                        {config.roles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </optgroup>
                      );
                    })}
                  <option value={CUSTOM_ROLE_VALUE}>Custom role...</option>
                </select>
                <ChevronDown className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-board-muted pointer-events-none" />
              </div>
              {selectedRole === CUSTOM_ROLE_VALUE && (
                <input
                  type="text"
                  value={customRole}
                  onChange={(e) => {
                    const nextRole = e.target.value;
                    setCustomRole(nextRole);
                    setRole(nextRole);
                  }}
                  placeholder="e.g. Set Builder"
                  className="mt-3 w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20"
                />
              )}
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5">
              <svg
                className="mt-0.5 h-4 w-4 shrink-0 text-red-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-xl border border-board-border text-sm text-board-muted hover:bg-board-border/50 hover:text-board-text transition-all duration-150"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2.5 rounded-xl font-semibold text-sm text-black transition-all duration-200 hover:shadow-lg hover:shadow-fire-500/20 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
              style={{
                background: "linear-gradient(135deg, #FFC107 0%, #FF8F00 100%)",
              }}
            >
              {saving ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Saving...
                </span>
              ) : isEditing ? (
                "Update Member"
              ) : (
                "Add Member"
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
