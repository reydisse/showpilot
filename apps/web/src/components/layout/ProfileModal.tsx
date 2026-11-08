import { useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  Camera,
  Check,
  CircleCheck,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { ProfileRecovery } from "./ProfileRecovery";
import { ProfilePasswordReset } from "./ProfilePasswordReset";
import { getPortableAvatarUrl } from "@/lib/avatar-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { SignOutControl } from "./SignOutControl";
import { ROLE_COLOURS, getAccountInitials } from "./account-role";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  pm: "Production Manager",
  tm: "Technical Manager",
  sm: "Stage Manager",
  member: "Member",
};

interface ProfilePanelProps {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image?: string | null;
  };
  role: string;
  orgName: string;
  onUserUpdated: (updates: { name?: string; image?: string }) => void;
}

export function ProfilePanel({
  user,
  role,
  orgName,
  onUserUpdated,
}: ProfilePanelProps) {
  const controls = useAccountProfile(user.id);
  const { profile, attempt } = controls;
  const [displayName, setDisplayName] = useState(
    controls.nameDraft ?? profile.data?.name ?? user.name,
  );
  useEffect(() => {
    if (controls.nameDraft === null && profile.data)
      setDisplayName(profile.data.name);
  }, [controls.nameDraft, profile.data]);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const savedAvatar = getPortableAvatarUrl(
    profile.data ? profile.data.image : user.image,
  );
  const avatarUrl = savedAvatar !== failedAvatarUrl ? savedAvatar : null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const lastPublished = useRef(JSON.stringify([user.name, user.image ?? ""]));
  useEffect(() => {
    if (!profile.data) return;
    const value = JSON.stringify([profile.data.name, profile.data.image ?? ""]);
    if (value === lastPublished.current) return;
    lastPublished.current = value;
    onUserUpdated({ name: profile.data.name, image: profile.data.image ?? "" });
  }, [profile.data, onUserUpdated]);
  useEffect(() => {
    if (controls.readFailed || attempt?.kind === "failed")
      recoveryRef.current?.scrollIntoView({ block: "nearest" });
  }, [controls.readFailed, attempt]);
  const roleColour = ROLE_COLOURS[role] ?? ROLE_COLOURS.member;
  const initials = getAccountInitials(displayName || user.name);
  const roleLabel = ROLE_LABELS[role] ?? role;
  const nameEmpty = !displayName.trim();
  const nameUnchanged = displayName.trim() === (profile.data?.name ?? user.name);
  const saving = attempt?.kind === "pending" && attempt.command.kind === "name";
  const uploadingPhoto =
    attempt?.kind === "pending" && attempt.command.kind !== "name";
  const saved = !!profile.data && nameUnchanged && !controls.locked;
  const handleSaveName = () => {
    if (!nameEmpty && !nameUnchanged) controls.saveName(displayName.trim());
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
        <div ref={recoveryRef} className="mb-4">
          <ProfileRecovery controls={controls} />
        </div>
        <div className="flex items-center gap-4 sm:gap-5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={controls.locked}
            className="group relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-bold text-white outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-fire-500 sm:size-24"
            style={{ backgroundColor: roleColour }}
            aria-label="Change profile photo"
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="size-full object-cover"
                onError={() => setFailedAvatarUrl(savedAvatar)}
              />
            ) : (
              initials
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {uploadingPhoto ? (
                <LoaderCircle className="size-5 animate-spin" />
              ) : (
                <Camera className="size-5" />
              )}
            </span>
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-board-text">
              Profile photo
            </p>
            <p className="mt-1 text-xs leading-5 text-board-muted">
              JPG, PNG, or WebP up to 10 MB. Photos save automatically.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 min-h-11"
              disabled={controls.locked}
              onClick={() => fileInputRef.current?.click()}
            >
              <Camera data-icon="inline-start" />
              {uploadingPhoto ? "Saving photo" : "Choose photo"}
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) controls.selectPhoto(file);
              event.target.value = "";
            }}
          />
        </div>

        <Separator className="my-6" />

        <section aria-labelledby="profile-account-heading">
          <h3
            id="profile-account-heading"
            className="text-sm font-semibold text-board-text"
          >
            Account
          </h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="profile-display-name">Display Name</Label>
              <Input
                id="profile-display-name"
                className="min-h-11"
                value={displayName}
                onChange={(event) => {
                  const draft = event.target.value.slice(0, 50);
                  setDisplayName(draft);
                  controls.setNameDraft(draft);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSaveName();
                }}
                aria-invalid={
                  controls.nameDraft !== null && nameEmpty
                }
                aria-describedby="profile-name-status"
              />
              <p id="profile-name-status" className="text-xs text-board-muted">
                {controls.nameDraft !== null && nameEmpty
                  ? "Enter a display name."
                  : profile.data && !nameUnchanged
                    ? `Saved name: ${profile.data.name}`
                    : "Use the name your team recognizes."}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                value={user.email}
                readOnly
                aria-readonly="true"
                className="min-h-11 text-board-muted"
              />
            </div>
          </div>
        </section>

        <Separator className="my-6" />

        <section aria-labelledby="profile-organization-heading">
          <h3
            id="profile-organization-heading"
            className="text-sm font-semibold text-board-text"
          >
            Organization
          </h3>
          <dl className="mt-4 grid gap-3 rounded-xl border border-board-border bg-board-bg/35 p-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[11px] text-board-muted">Role</dt>
              <dd
                className="mt-1 text-sm font-medium text-board-text"
                style={{ color: role === "owner" ? undefined : roleColour }}
              >
                {roleLabel}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] text-board-muted">Organization</dt>
              <dd className="mt-1 truncate text-sm font-medium text-board-text">
                {orgName}
              </dd>
            </div>
          </dl>
        </section>

        <Separator className="my-6" />

        <section aria-labelledby="profile-security-heading">
          <h3
            id="profile-security-heading"
            className="text-sm font-semibold text-board-text"
          >
            Security
          </h3>
          <div className="mt-4 overflow-hidden rounded-xl border border-board-border bg-board-bg/35">
            <div className="flex items-center gap-3 border-b border-board-border px-4 py-3.5">
              <BadgeCheck
                className={
                  user.emailVerified
                    ? "size-4 text-green-500"
                    : "size-4 text-fire-500"
                }
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-board-text">
                  Email verification
                </p>
                <p className="mt-0.5 text-xs text-board-muted">
                  {user.emailVerified
                    ? "Verified"
                    : "Verification is still required"}
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <KeyRound className="size-4 shrink-0 text-board-muted" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-board-text">
                    Password
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-board-muted">
                    Send a secure reset link to {user.email}.
                  </p>
                </div>
              </div>
              <ProfilePasswordReset userId={user.id} email={user.email} />
            </div>
          </div>
        </section>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-board-border bg-board-card px-4 py-3 sm:px-7 sm:py-4">
        <SignOutControl userId={user.id} />
        <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
          {saved && nameUnchanged ? (
            <span className="hidden items-center gap-1.5 text-xs text-green-400 min-[360px]:inline-flex">
              <CircleCheck className="size-4" />
              Saved
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="min-h-11 shrink-0"
            disabled={nameEmpty || nameUnchanged || controls.locked}
            onClick={() => void handleSaveName()}
          >
            {saving ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : nameUnchanged ? (
              <Check data-icon="inline-start" />
            ) : null}
            {saving ? "Saving" : "Save changes"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
