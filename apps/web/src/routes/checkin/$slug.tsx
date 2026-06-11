import { createFileRoute, redirect } from "@tanstack/react-router";
import { BoardSkeleton } from "@/components/ui/Skeleton";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Flame,
  KeyRound,
  CheckCircle2,
  XCircle,
  LogIn,
  LogOut,
  X,
  Camera,
  Loader2,
  Pencil,
} from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import {
  getPublicCheckInOrg,
  publicCheckInByMemberId,
  getPublicCrewMemberByMemberId,
  updatePublicCrewMemberPhotoByMemberId,
} from "@/lib/data";
import { fileToBase64 } from "@/lib/storage";

type CheckInResult = {
  memberId: string;
  name: string;
  photoUrl: string;
  role: string;
  isOnline: boolean;
};

const ALLOWED_PROFILE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
]);
const MAX_PROFILE_BYTES = 1_500_000;

const rememberedMemberKey = (slug: string) => `showpilot-checkin:${slug}:memberId`;

export const Route = createFileRoute("/checkin/$slug")({
  pendingComponent: () => <BoardSkeleton />,
  loader: async ({ params }) => {
    const org = await getPublicCheckInOrg({ data: { slug: params.slug } });
    if (!org) {
      throw redirect({ to: "/" });
    }
    return { slug: params.slug, orgName: org.name };
  },
  component: PublicCheckInPage,
});

function PublicCheckInPage() {
  const { slug, orgName } = Route.useLoaderData();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [error, setError] = useState("");
  const [profileError, setProfileError] = useState("");
  const [rememberedMember, setRememberedMember] = useState<CheckInResult | null>(null);
  const [restoringMember, setRestoringMember] = useState(true);
  const [editingNameMemberId, setEditingNameMemberId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [uploadingPhotoMemberId, setUploadingPhotoMemberId] = useState<string | null>(null);
  const [savingNameMemberId, setSavingNameMemberId] = useState<string | null>(null);

  const resetState = useCallback(() => {
    setResult(null);
    setError("");
    setProfileError("");
    setEditingNameMemberId(null);
    setEditingName("");
    setCode("");
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const restoreRememberedMember = async () => {
      if (typeof window === "undefined") return;
      const memberId = window.localStorage.getItem(rememberedMemberKey(slug));
      if (!memberId) {
        if (!cancelled) setRestoringMember(false);
        return;
      }

      try {
        const member = await getPublicCrewMemberByMemberId({ data: { slug, memberId } });
        if (!cancelled) {
          setRememberedMember(member ? { ...member } : null);
        }
        if (!member) {
          window.localStorage.removeItem(rememberedMemberKey(slug));
        }
      } catch {
        if (!cancelled) {
          setRememberedMember(null);
        }
      } finally {
        if (!cancelled) setRestoringMember(false);
      }
    };

    void restoreRememberedMember();

    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (!error) return;
    timerRef.current = setTimeout(() => {
      resetState();
      router.invalidate();
    }, 4000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [error, resetState, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError("");
    setResult(null);
    setProfileError("");
    setEditingNameMemberId(null);
    setEditingName("");

    try {
      const res = await publicCheckInByMemberId({ data: { slug, memberId: trimmed } });
      if (!res) {
        setError("Member not found");
        setCode("");
      } else {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(rememberedMemberKey(slug), res.memberId);
        }
        setResult(res);
        setRememberedMember(res);
        setCode("");
      }
    } catch {
      setError("Member not found");
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  const handleQuickToggle = async () => {
    if (!rememberedMember || loading) return;

    setLoading(true);
    setError("");
    setResult(null);
    setProfileError("");
    setEditingNameMemberId(null);
    setEditingName("");

    try {
      const res = await publicCheckInByMemberId({ data: { slug, memberId: rememberedMember.memberId } });
      if (!res) {
        setError("Member not found");
        setRememberedMember(null);
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(rememberedMemberKey(slug));
        }
      } else {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(rememberedMemberKey(slug), res.memberId);
        }
        setResult(res);
        setRememberedMember(res);
      }
    } catch {
      setError("Unable to update check-in right now");
    } finally {
      setLoading(false);
    }
  };

  const clearRememberedMember = () => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(rememberedMemberKey(slug));
    }
    setRememberedMember(null);
    setResult(null);
    setCode("");
    setError("");
    setProfileError("");
    setEditingNameMemberId(null);
    setEditingName("");
    inputRef.current?.focus();
  };

  const startNameEdit = (memberId: string | undefined | null, currentName: string) => {
    if (!memberId) return;
    setProfileError("");
    setEditingName(currentName);
    setEditingNameMemberId(memberId);
  };

  const cancelNameEdit = () => {
    setEditingNameMemberId(null);
    setEditingName("");
    setProfileError("");
  };

  const handleProfileUpdate = async (memberId: string | undefined | null) => {
    if (!memberId || savingNameMemberId === memberId) return;

    const nextName = editingName.trim();
    if (!nextName) {
      setProfileError("Name cannot be empty.");
      return;
    }

    if (nextName.length > 80) {
      setProfileError("Name must be 80 characters or less.");
      return;
    }

    setProfileError("");
    setSavingNameMemberId(memberId);

    try {
      const updated = await updatePublicCrewMemberPhotoByMemberId({
        data: {
          slug,
          memberId,
          name: nextName,
        },
      });

      if (!updated) {
        throw new Error("Unable to save name.");
      }

      setResult((prev) => {
        if (!prev || prev.memberId !== memberId) return prev;
        return { ...prev, name: updated.name };
      });

      setRememberedMember((prev) => {
        if (!prev || prev.memberId !== memberId) return prev;
        return { ...prev, name: updated.name };
      });

      setEditingNameMemberId(null);
      setEditingName("");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to update profile.");
    } finally {
      setSavingNameMemberId(null);
    }
  };

  const handlePhotoUpload = async (memberId: string | undefined | null, file: File | null) => {
    if (!memberId || !file) return;

    if (
      !ALLOWED_PROFILE_MIME_TYPES.has(file.type.toLowerCase()) &&
      !/\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name)
    ) {
      setProfileError("Please upload a valid image file (PNG, JPG, WebP, GIF, AVIF, or HEIC).");
      return;
    }

    if (file.size > MAX_PROFILE_BYTES) {
      setProfileError("Photo is too large. Use an image smaller than 1.5MB.");
      return;
    }

    setProfileError("");
    setUploadingPhotoMemberId(memberId);

    try {
      const photoUrl = await fileToBase64(file);
      const updated = await updatePublicCrewMemberPhotoByMemberId({
        data: {
          slug,
          memberId,
          photoUrl,
        },
      });

      if (!updated) {
        throw new Error("Unable to save photo.");
      }

      setResult((prev) => {
        if (!prev || prev.memberId !== memberId) return prev;
        return { ...prev, photoUrl: updated.photoUrl };
      });

      setRememberedMember((prev) => {
        if (!prev || prev.memberId !== memberId) return prev;
        return { ...prev, photoUrl: updated.photoUrl };
      });
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Failed to update photo.");
    } finally {
      setUploadingPhotoMemberId(null);
    }
  };

  const handlePhotoInputChange = (
    memberId: string | undefined | null,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.currentTarget.files?.[0] || null;
    void handlePhotoUpload(memberId, file);
    e.currentTarget.value = "";
  };

  const getPhotoUploadLabel = (memberId: string) =>
    uploadingPhotoMemberId === memberId ? "Uploading photo..." : "Change profile photo";

  return (
    <div className="min-h-screen bg-board-bg text-board-text">
      <div className="sticky top-0 z-10 bg-board-bg/80 backdrop-blur-xl border-b border-board-border px-5 py-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold">
            <span className="text-fire-500">Check-In</span>
          </h1>
          <p className="text-xs text-board-muted mt-1">{orgName}</p>
          <p className="text-xs text-board-muted">Enter your member ID</p>
        </div>
      </div>

      <main className="px-5 py-4 pb-8 max-w-lg mx-auto">
        <div className="flex flex-col items-center pt-8">
          {!result && !error && !restoringMember && rememberedMember && (
            <div className="w-full mb-6 rounded-2xl bg-board-card border border-board-border p-4 text-center space-y-4">
              <div className="mx-auto w-20 h-20 rounded-full bg-board-bg border border-board-border overflow-hidden">
                {rememberedMember.photoUrl ? (
                  <img
                    src={rememberedMember.photoUrl}
                    alt={rememberedMember.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-board-border text-board-muted text-xs">
                    {rememberedMember.name.charAt(0)}
                  </div>
                )}
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-board-muted mb-2">Welcome back</p>
                {editingNameMemberId === rememberedMember.memberId ? (
                  <div className="space-y-2">
                    <input
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      className="w-full max-w-xs mx-auto px-4 py-3 rounded-xl bg-board-bg border border-board-border text-board-text text-center text-base font-semibold"
                      placeholder="Your full name"
                    />
                    <div className="flex gap-2 justify-center">
                      <button
                        onClick={() => void handleProfileUpdate(rememberedMember.memberId)}
                        disabled={savingNameMemberId === rememberedMember.memberId}
                        className="px-3 py-2 rounded-xl bg-fire-500 text-white text-sm font-medium hover:bg-fire-600 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {savingNameMemberId === rememberedMember.memberId ? "Saving..." : "Save"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelNameEdit}
                        className="px-3 py-2 rounded-xl border border-board-border text-board-muted hover:text-board-text hover:border-fire-500/40 text-sm font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h2 className="text-xl font-bold text-board-text">{rememberedMember.name}</h2>
                    <p className="text-sm text-board-muted mt-1">{rememberedMember.role}</p>
                    <button
                      type="button"
                      onClick={() => startNameEdit(rememberedMember.memberId, rememberedMember.name)}
                      className="mt-2 inline-flex items-center gap-2 text-xs text-board-muted hover:text-board-text transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Edit name
                    </button>
                  </>
                )}
              </div>
              <label className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-board-border text-sm text-board-muted hover:text-board-text hover:border-fire-500/40 transition-colors cursor-pointer">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,image/avif,image/heic,image/heif"
                  className="hidden"
                  onChange={(e) => handlePhotoInputChange(rememberedMember.memberId, e)}
                  disabled={uploadingPhotoMemberId === rememberedMember.memberId}
                />
                {uploadingPhotoMemberId === rememberedMember.memberId ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {getPhotoUploadLabel(rememberedMember.memberId)}
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    {getPhotoUploadLabel(rememberedMember.memberId)}
                  </>
                )}
              </label>
              {profileError && <p className="text-xs text-red-300">{profileError}</p>}
              <button
                onClick={handleQuickToggle}
                disabled={loading}
                className={`w-full px-5 py-4 rounded-2xl font-semibold text-lg transition-colors ${
                  rememberedMember.isOnline
                    ? "bg-orange-500 text-white hover:bg-orange-600"
                    : "bg-fire-500 text-white hover:bg-fire-600"
                } disabled:opacity-40 disabled:cursor-not-allowed`}
              >
                {loading
                  ? "Working..."
                  : rememberedMember.isOnline
                    ? "Check Out"
                    : "Check In Again"}
              </button>
              <button
                onClick={clearRememberedMember}
                className="text-xs text-board-muted hover:text-board-text transition-colors"
              >
                Use a different ID
              </button>
            </div>
          )}

          {!result && !error && (
            <div className="w-full space-y-4 animate-in fade-in duration-200">
              <div className="text-center mb-6">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-fire-500/10 border border-fire-500/20 mb-4">
                  <KeyRound className="w-8 h-8 text-fire-500" />
                </div>
                <p className="text-board-muted text-sm">
                  {rememberedMember
                    ? "Or enter a different member ID"
                    : "Enter your member ID to check in or out"}
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                <input
                  ref={inputRef}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g. TD3917"
                  autoComplete="off"
                  autoFocus
                  className="w-full px-5 py-4 rounded-2xl bg-board-card border border-board-border text-board-text text-center text-2xl font-mono tracking-[0.2em] uppercase placeholder:text-board-muted/30 placeholder:tracking-[0.2em] focus:outline-none focus:border-fire-500 focus:ring-1 focus:ring-fire-500/30 transition-all"
                />
                <button
                  type="submit"
                  disabled={!code.trim() || loading}
                  className="w-full px-5 py-4 rounded-2xl bg-fire-500 text-white font-semibold text-lg hover:bg-fire-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? <Flame className="w-5 h-5 animate-pulse mx-auto" /> : "Check In"}
                </button>
              </form>
            </div>
          )}

          {result && (
            <div className="w-full text-center space-y-5 animate-float-in">
              <div
                className={`inline-flex items-center justify-center w-20 h-20 rounded-full ${
                  result.isOnline
                    ? "bg-green-500/15 border-2 border-green-500/30"
                    : "bg-orange-500/15 border-2 border-orange-500/30"
                }`}
              >
                {result.photoUrl ? (
                  <img
                    src={result.photoUrl}
                    alt={result.name}
                    className="w-full h-full rounded-full object-cover"
                  />
                ) : result.isOnline ? (
                  <LogIn className="w-9 h-9 text-green-400" />
                ) : (
                  <LogOut className="w-9 h-9 text-orange-400" />
                )}
              </div>

              {editingNameMemberId === result.memberId ? (
                <div className="space-y-2">
                  <input
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    className="w-full max-w-xs mx-auto px-4 py-3 rounded-xl bg-board-bg border border-board-border text-board-text text-center text-2xl font-semibold"
                    placeholder="Your full name"
                  />
                  <div className="flex gap-2 justify-center">
                    <button
                      onClick={() => void handleProfileUpdate(result.memberId)}
                      disabled={savingNameMemberId === result.memberId}
                      className="px-3 py-2 rounded-xl bg-fire-500 text-white text-sm font-medium hover:bg-fire-600 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingNameMemberId === result.memberId ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelNameEdit}
                      className="px-3 py-2 rounded-xl border border-board-border text-board-muted hover:text-board-text hover:border-fire-500/40 text-sm font-medium"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h2 className="text-2xl font-bold text-board-text">{result.name}</h2>
                  <p className="text-sm text-board-muted mt-1">{result.role}</p>
                  <button
                    type="button"
                    onClick={() => startNameEdit(result.memberId, result.name)}
                    className="mt-2 inline-flex items-center gap-2 text-xs text-board-muted hover:text-board-text transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit name
                  </button>
                </>
              )}

              <label className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-board-border text-sm text-board-muted hover:text-board-text hover:border-fire-500/40 transition-colors cursor-pointer">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp,image/gif,image/avif,image/heic,image/heif"
                  className="hidden"
                  onChange={(e) => handlePhotoInputChange(result.memberId, e)}
                  disabled={uploadingPhotoMemberId === result.memberId}
                />
                {uploadingPhotoMemberId === result.memberId ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {getPhotoUploadLabel(result.memberId)}
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    {getPhotoUploadLabel(result.memberId)}
                  </>
                )}
              </label>
              {profileError && <p className="text-xs text-red-300">{profileError}</p>}

              <div
                className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-base font-semibold ${
                  result.isOnline
                    ? "bg-green-500/15 text-green-400 border border-green-500/25"
                    : "bg-orange-500/15 text-orange-400 border border-orange-500/25"
                }`}
              >
                <CheckCircle2 className="w-5 h-5" />
                {result.isOnline ? "Checked In" : "Checked Out"}
              </div>

              <button
                onClick={() => {
                  resetState();
                  router.invalidate();
                }}
                className="inline-flex items-center gap-1.5 text-xs text-board-muted/60 hover:text-board-muted transition-colors pt-1"
              >
                <X className="w-3 h-3" />
                Done
              </button>
            </div>
          )}

          {error && (
            <div className="w-full text-center space-y-5 animate-float-in">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-500/15 border-2 border-red-500/30">
                <XCircle className="w-9 h-9 text-red-400" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-red-400">{error}</h2>
                <p className="text-sm text-board-muted mt-1">Check your ID and try again</p>
              </div>
              <p className="text-xs text-board-muted/60 pt-2">Returning to entry screen...</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
