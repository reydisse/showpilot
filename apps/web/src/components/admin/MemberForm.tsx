import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";
import { PhotoUpload } from "./PhotoUpload";
import { addCrewMember, updateCrewMember } from "@/lib/data";
import {
  crewProfileCommandSchema,
  crewProfileResultSchema,
  type CrewRosterMember,
  type CrewProfileResult,
} from "@/lib/crew-roster-contract";
import { readCrewPhoto } from "@/lib/crew-roster-photo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { DEPARTMENTS, type RoleDepartment } from "@/types";

export type CrewChange = {
  label: string;
  write: (requestId: string, signal: AbortSignal) => Promise<CrewProfileResult>;
  apply?: (result: CrewProfileResult) => void;
};
interface MemberFormProps {
  orgId: string;
  member: CrewRosterMember | null;
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  restoreFocus: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
  change: (change: CrewChange) => void;
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
const BUILT_IN_ROLE_SET = new Set(
  ROLE_GROUP_ORDER.flatMap((dept) => DEPARTMENTS[dept].roles),
);
const control =
  "min-h-11 min-w-11 rounded-xl border border-board-border px-4 py-2 text-sm text-board-text outline-none focus-visible:ring-2 focus-visible:ring-fire-500 disabled:opacity-40";

/** Draft stays mounted when the dialog closes. Team owns the exact pending write. */
export function MemberForm({
  orgId,
  member,
  open,
  disabled,
  onClose,
  restoreFocus,
  onSaved,
  onDirtyChange,
  change,
}: MemberFormProps) {
  const initialRole = member?.role || "";
  const initialUsesCustomRole =
    Boolean(initialRole) && !BUILT_IN_ROLE_SET.has(initialRole);
  const [memberId, setMemberId] = useState(member?.memberId || "");
  const [name, setName] = useState(member?.name || "");
  const [email, setEmail] = useState(member?.email || "");
  const [role, setRole] = useState(initialRole);
  const [selectedRole, setSelectedRole] = useState(
    initialUsesCustomRole ? CUSTOM_ROLE_VALUE : initialRole,
  );
  const [customRole, setCustomRole] = useState(
    initialUsesCustomRole ? initialRole : "",
  );
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const prefix = useId();
  const preparation = useRef<AbortController | null>(null);
  useEffect(() => () => preparation.current?.abort(), []);
  const dirty =
    memberId !== (member?.memberId || "") ||
    name !== (member?.name || "") ||
    email !== (member?.email || "") ||
    role !== initialRole ||
    photoFile !== null;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const close = () => {
    preparation.current?.abort();
    onClose();
  };
  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (disabled || preparation.current) return;
    const controller = new AbortController();
    preparation.current = controller;
    setPreparing(true);
    setError("");
    try {
      const photoUrl = photoFile
        ? await readCrewPhoto(photoFile, controller.signal)
        : member?.photoUrl || "";
      controller.signal.throwIfAborted();
      const fields = {
        memberId,
        name,
        email: email.trim().toLowerCase(),
        role,
        photoUrl,
      };
      const parsed = crewProfileCommandSchema.safeParse(
        member
          ? {
              kind: "update",
              orgId,
              id: member.id,
              expectedRevision: member.profileRevision,
              updates: fields,
            }
          : { kind: "create", orgId, ...fields },
      );
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((issue) => issue.message).join(" "),
        );
      const command = parsed.data;
      if (command.kind === "delete")
        throw new Error("Choose a crew profile to save.");
      change({
        label: `${member ? "Update" : "Add"} crew member ${name.trim()}`,
        write: async (requestId, signal) =>
          crewProfileResultSchema.parse(
            command.kind === "create"
              ? await addCrewMember({ data: { ...command, requestId }, signal })
              : await updateCrewMember({
                  data: { ...command, requestId },
                  signal,
                }),
          ),
        apply: onSaved,
      });
      onClose();
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not prepare the crew profile.",
        );
    } finally {
      if (preparation.current === controller) {
        preparation.current = null;
        setPreparing(false);
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreFocus();
        }}
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto border-board-border bg-board-card text-board-text"
      >
        <DialogTitle>
          {member ? "Edit crew member" : "Add crew member"}
        </DialogTitle>
        <DialogDescription>
          Your draft is kept when you close this editor. Crew profiles support
          badges and scheduling; they do not grant account access.
        </DialogDescription>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <fieldset
            disabled={disabled || preparing}
            className="min-w-0 space-y-4"
          >
            <PhotoUpload
              currentPhotoURL={member?.photoUrl}
              onFileSelect={setPhotoFile}
              file={photoFile}
            />
            <div className="space-y-4">
              {/* Member ID */}
              <div className="group">
                <label
                  htmlFor={`${prefix}-badge`}
                  className="mb-1.5 block text-sm font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
                >
                  Member ID
                </label>
                <input
                  id={`${prefix}-badge`}
                  type="text"
                  value={memberId}
                  onChange={(e) => setMemberId(e.target.value.toUpperCase())}
                  placeholder="e.g. TD3917"
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 uppercase tracking-wider font-mono"
                />
                <p className="mt-1 text-sm text-board-muted/70">
                  Used for badge scanning and quick check-in
                </p>
              </div>

              {/* Name */}
              <div className="group">
                <label
                  htmlFor={`${prefix}-name`}
                  className="mb-1.5 block text-sm font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
                >
                  Full Name
                </label>
                <input
                  id={`${prefix}-name`}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Sarah Johnson"
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20"
                />
              </div>

              {/* Email */}
              <div className="group">
                <label
                  htmlFor={`${prefix}-email`}
                  className="mb-1.5 block text-sm font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
                >
                  Email address
                </label>
                <input
                  id={`${prefix}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="crew@example.com"
                  className="w-full px-4 py-2.5 rounded-xl bg-board-bg border border-board-border text-board-text placeholder:text-board-muted/50 outline-none transition-all duration-200 focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20"
                />
                <p className="mt-1 text-sm text-board-muted/70">
                  Used for accountless schedule requests and reminders
                </p>
              </div>

              {/* Role */}
              <div className="group">
                <label
                  htmlFor={`${prefix}-role`}
                  className="mb-1.5 block text-sm font-medium uppercase tracking-wider text-board-muted transition-colors group-focus-within:text-fire-500"
                >
                  Role
                </label>
                <div className="relative">
                  <select
                    id={`${prefix}-role`}
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
                    aria-label="Custom crew role"
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
          </fieldset>
          {error && (
            <p role="alert" className="mt-4 flex gap-2 text-sm text-red-400">
              <AlertCircle className="size-4 shrink-0" />
              {error}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={close} className={control}>
              Close editor
            </button>
            <button
              type="submit"
              disabled={disabled || preparing || !dirty}
              className={`${control} bg-fire-500 font-semibold text-black`}
            >
              {preparing
                ? "Preparing photo…"
                : member
                  ? "Save crew member"
                  : "Add crew member"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
