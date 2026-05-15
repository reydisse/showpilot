import { useState, useEffect, useRef, useCallback } from "react";
import { X, Camera, Check, LogOut, ChevronRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useNavigate } from "@tanstack/react-router";

export const ROLE_COLOURS: Record<string, string> = {
  owner: "#e84040",
  admin: "#f5a623",
  pm: "#4f8eff",
  tm: "#00d4a0",
  sm: "#9b7be8",
  member: "#6b7280",
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
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const size = Math.min(img.width, img.height, maxPx);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d")!;
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, size, size);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob failed"));
      }, "image/jpeg", 0.85);
    };
    img.onerror = reject;
    img.src = url;
  });
}

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
  user: { id: string; name: string; email: string; image?: string | null };
  role: string;
  orgName: string;
  onUserUpdated: (updates: { name?: string; image?: string }) => void;
}

export function ProfileModal({ open, onClose, user, role, orgName, onUserUpdated }: ProfileModalProps) {
  const [displayName, setDisplayName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.image ?? "");
  const [nameSaved, setNameSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [signOutPhase, setSignOutPhase] = useState<"idle" | "confirm">("idle");
  const [countdown, setCountdown] = useState(3);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Sync user data when modal opens
  useEffect(() => {
    if (open) {
      setDisplayName(user.name);
      setAvatarUrl(user.image ?? "");
      setSignOutPhase("idle");
      setNameSaved(false);
    }
  }, [open, user.name, user.image]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Focus trap
  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last?.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [open]);

  // Sign-out countdown
  useEffect(() => {
    if (signOutPhase !== "confirm") {
      if (countdownRef.current) clearInterval(countdownRef.current);
      setCountdown(3);
      return;
    }
    setCountdown(3);
    countdownRef.current = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          clearInterval(countdownRef.current!);
          setSignOutPhase("idle");
          return 3;
        }
        return n - 1;
      });
    }, 1000);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [signOutPhase]);

  const handleSaveName = useCallback(async () => {
    const trimmed = displayName.trim();
    if (!trimmed || trimmed === user.name || saving) return;
    setSaving(true);
    try {
      await authClient.updateUser({ name: trimmed });
      onUserUpdated({ name: trimmed });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      // noop
    }
    setSaving(false);
  }, [displayName, user.name, saving, onUserUpdated]);

  const handlePhotoSelect = useCallback(async (file: File) => {
    setUploadingPhoto(true);
    try {
      const blob = await resizeImageToBlob(file, 256);
      const formData = new FormData();
      formData.append("file", blob, "avatar.jpg");
      const res = await fetch("/api/user/avatar", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Upload failed");
      const { url } = await res.json() as { url: string };
      await authClient.updateUser({ image: url });
      setAvatarUrl(url);
      onUserUpdated({ image: url });
    } catch {
      // Best-effort: show local preview as fallback
      const localUrl = URL.createObjectURL(file);
      setAvatarUrl(localUrl);
    }
    setUploadingPhoto(false);
  }, [onUserUpdated]);

  const handleSignOut = useCallback(async () => {
    if (signOutPhase === "idle") {
      setSignOutPhase("confirm");
    } else {
      await authClient.signOut();
      navigate({ to: "/login" });
    }
  }, [signOutPhase, navigate]);

  if (!open) return null;

  const roleColour = ROLE_COLOURS[role] ?? ROLE_COLOURS.member;
  const initials = getInitials(displayName || user.name);
  const roleLabel = ROLE_LABELS[role] ?? role;
  const nameUnchanged = displayName.trim() === user.name || !displayName.trim();

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-modal="true"
      role="dialog"
    >
      <div className="bg-board-card border border-board-border rounded-2xl w-full max-w-sm mx-4 shadow-2xl overflow-hidden">
        {/* Close button */}
        <div className="flex items-center justify-between px-5 pt-5 pb-0">
          <span className="text-sm font-semibold text-board-text">Profile</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-board-muted hover:text-board-text hover:bg-board-border/50 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Avatar */}
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingPhoto}
              className="relative w-[72px] h-[72px] rounded-full overflow-hidden shrink-0 group"
              style={{ backgroundColor: roleColour }}
              title="Change photo"
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt={displayName} className="w-full h-full object-cover" />
              ) : (
                <span className="text-xl font-bold text-white select-none">{initials}</span>
              )}
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="w-5 h-5 text-white" />
              </div>
              {uploadingPhoto && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-[11px] text-board-muted hover:text-board-text transition-colors"
            >
              Change Photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoSelect(f); e.target.value = ""; }}
            />
          </div>

          {/* Display name */}
          <div className="space-y-1.5">
            <label className="block text-xs text-board-muted">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, 50))}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); }}
              className="w-full px-3 py-2 rounded-lg bg-board-bg border border-board-border text-sm text-board-text placeholder:text-board-muted/50 focus:outline-none focus:border-fire-500 transition-colors"
              placeholder="Your name"
            />
            <button
              onClick={handleSaveName}
              disabled={nameUnchanged || saving}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-fire-500 text-black disabled:opacity-40 hover:bg-fire-400 transition-colors"
            >
              {nameSaved ? (
                <><Check className="w-3 h-3" /> Name updated</>
              ) : saving ? "Saving…" : "Save Changes"}
            </button>
          </div>

          {/* Divider */}
          <div className="h-px bg-board-border" />

          {/* Role + org */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-board-muted">Role</span>
              <span className="text-xs font-medium" style={{ color: roleColour }}>{roleLabel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-board-muted">Organization</span>
              <span className="text-xs font-medium text-board-text truncate max-w-[160px]">{orgName}</span>
            </div>
          </div>

          {/* Divider */}
          <div className="h-px bg-board-border" />

          {/* Sign out */}
          <button
            onClick={handleSignOut}
            className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              signOutPhase === "confirm"
                ? "bg-red-500/20 text-red-400 border border-red-500/30"
                : "text-red-400 hover:bg-red-500/10"
            }`}
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span className="flex-1 text-left">
              {signOutPhase === "confirm"
                ? `Tap again to sign out (${countdown})`
                : "Sign Out"}
            </span>
            {signOutPhase === "idle" && <ChevronRight className="w-3.5 h-3.5 opacity-40" />}
          </button>
        </div>
      </div>
    </div>
  );
}
