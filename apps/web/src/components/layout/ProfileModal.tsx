import { useCallback, useRef, useState } from "react";
import { Camera, Check, CircleCheck, LoaderCircle, LogOut } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export const ROLE_COLOURS: Record<string, string> = {
  owner: "#dc2626",
  admin: "#b45309",
  pm: "#2563eb",
  tm: "#047857",
  sm: "#7c3aed",
  member: "#4b5563",
};

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  pm: "Production Manager",
  tm: "Technical Manager",
  sm: "Stage Manager",
  member: "Member",
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

async function resizeImageToBlob(file: File, maxPx = 256): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const size = Math.min(image.width, image.height, maxPx);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("Your browser could not prepare that image"));
        return;
      }
      const sourceX = (image.width - size) / 2;
      const sourceY = (image.height - size) / 2;
      context.drawImage(image, sourceX, sourceY, size, size, 0, 0, size, size);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Your browser could not prepare that image"));
      }, "image/jpeg", 0.85);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("That image could not be opened"));
    };
    image.src = objectUrl;
  });
}

function avatarUrlFrom(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("url" in value)) return null;
  const url = value.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

interface ProfilePanelProps {
  user: { id: string; name: string; email: string; image?: string | null };
  role: string;
  orgName: string;
  onUserUpdated: (updates: { name?: string; image?: string }) => void;
  onSignOut: () => Promise<void>;
}

export function ProfilePanel({ user, role, orgName, onUserUpdated, onSignOut }: ProfilePanelProps) {
  const [displayName, setDisplayName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.image ?? "");
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [saved, setSaved] = useState(true);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const roleColour = ROLE_COLOURS[role] ?? ROLE_COLOURS.member;
  const initials = getInitials(displayName || user.name);
  const roleLabel = ROLE_LABELS[role] ?? role;
  const nameUnchanged = displayName.trim() === user.name || !displayName.trim();

  const handleSaveName = useCallback(async () => {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === user.name || saving) return;
    setSaving(true);
    setProfileError("");
    try {
      const result = await authClient.updateUser({ name: trimmed });
      if (result.error) throw new Error(result.error.message ?? "Could not update your name");
      onUserUpdated({ name: trimmed });
      setSaved(true);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not update your name");
    } finally {
      setSaving(false);
    }
  }, [displayName, onUserUpdated, saving, user.name]);

  const handlePhotoSelect = useCallback(async (file: File) => {
    setUploadingPhoto(true);
    setProfileError("");
    try {
      if (!file.type.startsWith("image/")) throw new Error("Choose an image file");
      if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB");
      const blob = await resizeImageToBlob(file, 256);
      const formData = new FormData();
      formData.append("file", blob, "avatar.jpg");
      const response = await fetch("/api/user/avatar", { method: "POST", body: formData });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Could not upload your photo";
        throw new Error(message);
      }
      const url = avatarUrlFrom(payload);
      if (!url) throw new Error("The photo upload returned an invalid response");
      const result = await authClient.updateUser({ image: url });
      if (result.error) throw new Error(result.error.message ?? "Could not save your photo");
      setAvatarUrl(url);
      onUserUpdated({ image: url });
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Could not save your photo");
    } finally {
      setUploadingPhoto(false);
    }
  }, [onUserUpdated]);

  const requestSignOut = async () => {
    if (!confirmSignOut) {
      setConfirmSignOut(true);
      window.setTimeout(() => setConfirmSignOut(false), 4_000);
      return;
    }
    await onSignOut();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
        <div className="flex items-center gap-4 sm:gap-5">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingPhoto}
            className="group relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-bold text-white outline-none ring-offset-2 focus-visible:ring-2 focus-visible:ring-fire-500 sm:size-24"
            style={{ backgroundColor: roleColour }}
            aria-label="Change profile photo"
          >
            {avatarUrl ? <img src={avatarUrl} alt={displayName} className="size-full object-cover" /> : initials}
            <span className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {uploadingPhoto ? <LoaderCircle className="size-5 animate-spin" /> : <Camera className="size-5" />}
            </span>
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-board-text">Profile photo</p>
            <p className="mt-1 text-xs leading-5 text-board-muted">JPG, PNG, WebP, or GIF up to 10 MB. Photos save automatically.</p>
            <Button type="button" variant="outline" size="sm" className="mt-3" disabled={uploadingPhoto} onClick={() => fileInputRef.current?.click()}>
              <Camera data-icon="inline-start" />
              {uploadingPhoto ? "Saving photo" : "Choose photo"}
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handlePhotoSelect(file);
              event.target.value = "";
            }}
          />
        </div>

        <Separator className="my-6" />

        <section aria-labelledby="profile-account-heading">
          <h3 id="profile-account-heading" className="text-sm font-semibold text-board-text">Account</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="profile-display-name">Display Name</Label>
              <Input
                id="profile-display-name"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value.slice(0, 50));
                  setSaved(false);
                }}
                onKeyDown={(event) => { if (event.key === "Enter") void handleSaveName(); }}
                aria-invalid={Boolean(profileError)}
              />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" value={user.email} readOnly aria-readonly="true" className="text-board-muted" />
            </div>
          </div>
        </section>

        <Separator className="my-6" />

        <section aria-labelledby="profile-organization-heading">
          <h3 id="profile-organization-heading" className="text-sm font-semibold text-board-text">Organization</h3>
          <dl className="mt-4 grid gap-3 rounded-xl border border-board-border bg-board-bg/35 p-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-[11px] text-board-muted">Role</dt>
              <dd className="mt-1 text-sm font-medium" style={{ color: roleColour }}>{roleLabel}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] text-board-muted">Organization</dt>
              <dd className="mt-1 truncate text-sm font-medium text-board-text">{orgName}</dd>
            </div>
          </dl>
        </section>

        {profileError ? <p role="alert" className="mt-5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">{profileError}</p> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-board-border bg-board-card px-4 py-3 sm:px-7 sm:py-4">
        <Button type="button" variant="ghost" size="sm" className="shrink-0 justify-start px-2 text-red-400 hover:bg-red-500/10 hover:text-red-300 sm:px-3" onClick={() => void requestSignOut()}>
          <LogOut data-icon="inline-start" />
          {confirmSignOut ? "Tap again to sign out" : "Sign Out"}
        </Button>
        <div className="flex min-w-0 items-center justify-end gap-2 sm:gap-3">
          {saved && nameUnchanged ? <span className="hidden items-center gap-1.5 text-xs text-green-400 min-[360px]:inline-flex"><CircleCheck className="size-4" />Saved</span> : null}
          <Button type="button" size="sm" className="shrink-0" disabled={nameUnchanged || saving} onClick={() => void handleSaveName()}>
            {saving ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : nameUnchanged ? <Check data-icon="inline-start" /> : null}
            {saving ? "Saving" : "Save changes"}
          </Button>
        </div>
      </footer>
    </div>
  );
}
